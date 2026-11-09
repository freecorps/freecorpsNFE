import { describe, expect, it } from "vite-plus/test";
import {
  captureFailureText,
  captureMessage,
  captureSituation,
  forOrigin,
  knownCaptureCode,
  queryOutcome,
  releaseFailureText,
  stopMessage,
} from "./capture-messages";

/**
 * Codes the server can leave on a capture (`captures.get` shows the stream's code or, without
 * one, its operation's), by where they come from in `platform/convex`: `captureAttention` and the
 * checkpoint (`captureProcessing.ts`), the pauses (`pauseOperation`), the worker's outcomes
 * (`captureWorker.ts`), the vault's refusals (`certificateUse.authorizeTransport`), the site's
 * decision (`lib/siteCapture.ts`) and the transfer (`captures.ts`).
 */
const streamCodes = [
  // captureProcessing.checkpoint and recovery
  "NO_DOCUMENTS",
  "HISTORY_LIMITED",
  "NSU_GAP",
  "RECONCILING_GAP",
  "SOURCE_CONSUMPTION_BLOCKED",
  "SOURCE_CURSOR_UNKNOWN",
  "RECONCILIATION_INCOMPLETE",
  "RECONCILIATION_UNAVAILABLE",
  "SOURCE_CURSOR_REGRESSION",
  "REPEATED_NSU",
  "NSU_CONTENT_CONFLICT",
  "ACCESS_REVOKED",
  // captureWorker outcomes
  "CAPTURE_INACTIVE",
  "SOURCE_COOLDOWN",
  "BATCH_UNAVAILABLE",
  "BATCH_HASH_MISMATCH",
  "FISCAL_TRANSPORT_DISABLED",
  "SOURCE_HTTP_ERROR",
  "SOURCE_RESULT_UNCERTAIN",
  "CAPTURE_CHANGED",
  "SOURCE_RESPONSE_INVALID",
  // vault and site refusals
  "OPERATION_CHANGED",
  "CERTIFICATE_UNAVAILABLE",
  "CERTIFICATE_CHANGED",
  "FISCAL_PROOF_DENIED",
  "FISCAL_PROOF_STEP_COMPLETE",
  "CAPTURE_FISCAL_DENIED",
  "CAPTURE_FISCAL_HALTED",
  "CAPTURE_TERMS_PENDING",
  "SITE_CAPTURE_HOURLY_LIMIT",
  // pauses
  "PAUSED_BY_USER",
  "CAPTURE_RELEASE_WITHDRAWN",
  "ATTEMPTS_EXHAUSTED",
  "RECOVERY_BUDGET_EXHAUSTED",
  "RECONCILIATION_REQUIRED",
  "QUOTA_EXCEEDED",
  "PLAN_INACTIVE",
  "PLAN_REQUIRED",
  "CAPACITY_INVENTORY_REQUIRED",
  "TASK_FAILED",
  // transfer
  "TRANSFERRED",
];
/** Refusals of the panel's actions. */
const actionCodes = [
  "STREAM_CONFLICT",
  "TRANSFER_NOT_FOUND",
  "OPERATION_CONFLICT",
  "GAP_NOT_ACCEPTABLE",
  "GAP_CONFIRMATION_MISMATCH",
  "GAP_REASON_INVALID",
  "INTEGRATION_ACCESS_REVOKED",
  "CAPTURE_PAUSED",
  "CAPTURE_DEMONSTRATION_DENIED",
  "ORGANIZATION_CLOSED",
  "RATE_LIMITED",
  "ACCESS_DENIED",
  "SCOPE_DENIED",
  "RECONCILIATION_REQUIRED",
  "CERTIFICATE_UNAVAILABLE",
  "SOURCE_COOLDOWN",
];
/** Waits and information of a capture that keeps going: nothing for the person to do. */
const informative = ["NO_DOCUMENTS", "HISTORY_LIMITED", "RECONCILING_GAP"];
const jargon = /\b(cursor|stream|NSU|lote|envelopes?|checkpoint|batch)\b/i;

describe("mensagens da captura (#432)", () => {
  it.each([true, false])(
    "todo código que o servidor deixa tem motivo e o que fazer (produção: %s)",
    (production) => {
      for (const code of streamCodes) {
        expect(knownCaptureCode(code, production), code).toBe(true);
        const message = captureMessage(code, production)!;
        expect(message.reason, code).toMatch(/\.$/);
        if (!informative.includes(code)) expect(message.todo, code).toBeTruthy();
      }
    },
  );
  it.each([true, false])("sem jargão (produção: %s)", (production) => {
    for (const code of [...streamCodes, ...actionCodes]) {
      const message = captureMessage(code, production)!;
      expect(`${message.reason} ${message.todo ?? ""}`, code).not.toMatch(jargon);
      expect(captureFailureText(code, production), code).not.toMatch(jargon);
    }
  });
  it("o corte da Freecorps (#601) só com a marca do servidor, e só em Produção", () => {
    for (const code of ["ACCESS_REVOKED", "FISCAL_TRANSPORT_DISABLED"]) {
      const cut = stopMessage({ code, freecorpsCut: true }, true)!;
      expect(cut.action, code).toBe("resume");
      expect(cut.reason, code).toMatch(/^A Freecorps pausou a captura fiscal de todas as empresas/);
      expect(cut.todo, code).toBe("Retome a captura: ela continua do ponto em que parou.");
      expect(`${cut.reason} ${cut.todo}`).not.toMatch(jargon);
      // Without the mark, the code's own words.
      expect(stopMessage({ code, freecorpsCut: false }, true), code).toEqual(
        captureMessage(code, true),
      );
      expect(stopMessage({ code }, true), code).toEqual(captureMessage(code, true));
      expect(stopMessage({ code, freecorpsCut: true }, false), code).toEqual(
        captureMessage(code, false),
      );
    }
    expect(stopMessage({ code: "ACCESS_REVOKED" }, true)!.reason).toMatch(/^Mudou o acesso/);
  });
  it.each([true, false])(
    "na captura de uma integração, quem retoma é a integração (#607; produção: %s)",
    (production) => {
      const consoleOrigin = { kind: "console", integration: null } as const;
      const named = { kind: "integration", integration: "ERP Serra" } as const;
      const unnamed = { kind: "integration", integration: null } as const;
      const viaApi = "com a ação resume em POST /v1/connections/nfe.";
      const messages = [
        ...streamCodes.map((code) => captureMessage(code, production)!),
        stopMessage({ code: "ACCESS_REVOKED", freecorpsCut: true }, production)!,
      ];
      for (const message of messages) {
        // The console's capture keeps its words; the reason and the action never change.
        expect(forOrigin(message, consoleOrigin)).toBe(message);
        const integration = forOrigin(message, named);
        expect(integration.reason).toBe(message.reason);
        expect(integration.action).toBe(message.action);
        expect(integration.todo ?? "", message.reason).not.toMatch(/[Rr]etome/);
        if (message.action === "resume")
          expect(integration.todo, message.reason).toContain(
            `ntegração “ERP Serra” precisa retomar a captura, ${viaApi}`,
          );
      }
      // The Freecorps cut, by name or without one.
      const cut = stopMessage({ code: "ACCESS_REVOKED", freecorpsCut: true }, true)!;
      expect(forOrigin(cut, named).todo).toBe(
        `A integração “ERP Serra” precisa retomar a captura, ${viaApi} A captura continua do ponto em que parou.`,
      );
      expect(forOrigin(cut, unnamed).todo).toBe(
        `A integração que ativou a captura precisa retomá-la, ${viaApi} A captura continua do ponto em que parou.`,
      );
      // What the person still does comes first.
      expect(forOrigin(captureMessage("REPEATED_NSU", production)!, named).todo).toMatch(
        /^Confira se outro sistema, como o ERP ou o contador, consulta .+ por este CNPJ\. A integração “ERP Serra” precisa retomar/,
      );
      // And what comes after the resume, after it.
      for (const code of [
        "SOURCE_CURSOR_UNKNOWN",
        "RECONCILIATION_INCOMPLETE",
        "RECONCILIATION_REQUIRED",
        "ATTEMPTS_EXHAUSTED",
        "TASK_FAILED",
      ])
        expect(forOrigin(captureMessage(code, production)!, unnamed).todo, code).toBe(
          `A integração que ativou a captura precisa retomá-la, ${viaApi} Se acontecer de novo, fale com o suporte da Freecorps com os detalhes técnicos abaixo.`,
        );
      expect(forOrigin(captureMessage("RECONCILIATION_UNAVAILABLE", production)!, named).todo).toBe(
        `A integração “ERP Serra” precisa retomar a captura, ${viaApi} A captura localiza até onde vai o trecho perdido, e depois o Proprietário decide aqui se aceita a perda.`,
      );
      // An optional resume stays optional.
      expect(forOrigin(captureMessage("CAPTURE_INACTIVE", production)!, named).todo).toBe(
        `Se quiser voltar a receber documentos, a integração “ERP Serra” precisa retomar a captura, ${viaApi}`,
      );
      // A todo that does not ask to resume stays.
      const support = captureMessage("BATCH_UNAVAILABLE", production)!;
      expect(forOrigin(support, named)).toBe(support);
    },
  );
  it("Produção fala da Receita; o Sandbox, da fonte de teste", () => {
    expect(captureMessage("REPEATED_NSU", true)!.reason).toMatch(/^A Receita/);
    expect(captureMessage("REPEATED_NSU", false)!.reason).toMatch(/^A fonte de teste/);
    expect(captureMessage("FISCAL_TRANSPORT_DISABLED", false)!.reason).toMatch(
      /^O Sandbox não consulta a Receita/,
    );
  });
  it("a recusa de uma ação junta motivo e o que fazer, como no exemplo da issue", () => {
    expect(captureFailureText("STREAM_CONFLICT", true)).toBe(
      "Outra organização já captura esta empresa. Peça a ela um código de transferência.",
    );
    // The action's own words when they differ from the panel's.
    expect(captureFailureText("CERTIFICATE_UNAVAILABLE", true)).toMatch(/e tente de novo\.$/);
    expect(captureFailureText("UNHEARD_OF", true)).toBeNull();
    // A code with nothing to receive (#461): check it with the origin, or start the capture by the
    // button of that environment.
    expect(captureFailureText("TRANSFER_NOT_FOUND", true)).toBe(
      "Nenhuma outra organização tem uma captura desta empresa para transferir. Confira o código com a organização de origem. Se não houver transferência, use Iniciar captura fiscal.",
    );
    expect(captureFailureText("TRANSFER_NOT_FOUND", false)).toMatch(
      /use Ativar captura no sandbox\.$/,
    );
  });
  it("a recusa da Receita pelo código dela, e o código desconhecido, ainda dizem algo útil", () => {
    expect(captureMessage("SOURCE_589", true)).toEqual({
      action: "support",
      reason: "A Receita recusou a consulta (código 589).",
      todo: "Fale com o suporte da Freecorps antes de retomar, com os detalhes técnicos abaixo.",
    });
    expect(captureMessage("SOURCE_108", true)!.todo).toMatch(/tenta de novo em uma hora/);
    // The 999 is retried by itself; the third in a row stops it, and resuming is the way on (#195).
    expect(captureMessage("SOURCE_999", true)).toMatchObject({
      action: "resume",
      reason: expect.stringMatching(
        /código 999\).*duas vezes; no terceiro erro seguido, ela para\./,
      ),
      todo: expect.stringMatching(/^Retome a captura\./),
    });
    expect(captureMessage("UNHEARD_OF", true)!.reason).toMatch(/motivo que este painel/);
    expect(captureMessage(null, true)).toBeNull();
    // Names of the object's prototype are not codes.
    for (const name of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect(knownCaptureCode(name, true), name).toBe(false);
      expect(captureFailureText(name, true), name).toBeNull();
      expect(captureMessage(name, true)!.reason, name).toMatch(/motivo que este painel/);
      expect(releaseFailureText(name), name).toMatch(/Não foi possível concluir/);
    }
  });
  it("cota, plano e certificado em Produção voltam sozinhos; no Sandbox, retome", () => {
    for (const code of ["QUOTA_EXCEEDED", "PLAN_INACTIVE", "CERTIFICATE_UNAVAILABLE"]) {
      expect(captureMessage(code, true)!.todo, code).toMatch(/volta sozinha/);
      expect(captureMessage(code, false)!.todo, code).toMatch(/[Rr]etome/);
    }
  });
  it("cada código diz o que resolve a causa, de acordo com o que fazer", () => {
    const actions: Record<string, string> = {
      NO_DOCUMENTS: "none",
      HISTORY_LIMITED: "none",
      CERTIFICATE_CHANGED: "none",
      NSU_GAP: "wait",
      RECONCILING_GAP: "wait",
      SOURCE_COOLDOWN: "wait",
      SOURCE_HTTP_ERROR: "wait",
      SOURCE_RESULT_UNCERTAIN: "wait",
      CAPTURE_CHANGED: "wait",
      OPERATION_CHANGED: "wait",
      CAPTURE_FISCAL_HALTED: "wait",
      CAPTURE_TERMS_PENDING: "release",
      SITE_CAPTURE_HOURLY_LIMIT: "wait",
      RATE_LIMITED: "wait",
      SOURCE_CONSUMPTION_BLOCKED: "resume",
      SOURCE_CURSOR_UNKNOWN: "resume",
      RECONCILIATION_INCOMPLETE: "resume",
      RECONCILIATION_UNAVAILABLE: "resume",
      RECONCILIATION_REQUIRED: "resume",
      REPEATED_NSU: "resume",
      ACCESS_REVOKED: "resume",
      CAPTURE_INACTIVE: "resume",
      CAPTURE_FISCAL_DENIED: "resume",
      ATTEMPTS_EXHAUSTED: "resume",
      TASK_FAILED: "resume",
      PAUSED_BY_USER: "resume",
      TRANSFERRED: "resume",
      CAPTURE_PAUSED: "resume",
      SOURCE_CURSOR_REGRESSION: "support",
      NSU_CONTENT_CONFLICT: "support",
      BATCH_UNAVAILABLE: "support",
      BATCH_HASH_MISMATCH: "support",
      SOURCE_RESPONSE_INVALID: "support",
      RECOVERY_BUDGET_EXHAUSTED: "support",
      FISCAL_TRANSPORT_DISABLED: "support",
      FISCAL_PROOF_DENIED: "support",
      FISCAL_PROOF_STEP_COMPLETE: "support",
      CERTIFICATE_UNAVAILABLE: "certificate",
      QUOTA_EXCEEDED: "usage",
      PLAN_INACTIVE: "usage",
      PLAN_REQUIRED: "usage",
      CAPACITY_INVENTORY_REQUIRED: "usage",
      CAPTURE_RELEASE_WITHDRAWN: "release",
      STREAM_CONFLICT: "transfer",
      TRANSFER_NOT_FOUND: "transfer",
      OPERATION_CONFLICT: "none",
      GAP_NOT_ACCEPTABLE: "none",
      GAP_CONFIRMATION_MISMATCH: "none",
      GAP_REASON_INVALID: "none",
      INTEGRATION_ACCESS_REVOKED: "none",
      CAPTURE_DEMONSTRATION_DENIED: "none",
      ORGANIZATION_CLOSED: "none",
      ACCESS_DENIED: "none",
      SCOPE_DENIED: "none",
    };
    // Every code the panel or an action can show is declared.
    expect(Object.keys(actions).sort()).toEqual(
      [...new Set([...streamCodes, ...actionCodes])].sort(),
    );
    for (const [code, action] of Object.entries(actions)) {
      const message = captureMessage(code, true)!;
      expect(message.action, code).toBe(action);
      // "O que fazer" and the action agree: resuming is asked only where it solves the cause.
      if (action === "resume" && message.todo) expect(message.todo, code).toMatch(/[Rr]etome/);
      if (action === "support") expect(message.todo, code).toMatch(/Freecorps/);
      if (action !== "resume" && action !== "usage" && action !== "certificate")
        expect(message.todo ?? "", code).not.toMatch(/^Retome/);
    }
    // The Sandbox without a source: nothing to do there, and resuming would stop again.
    expect(captureMessage("FISCAL_TRANSPORT_DISABLED", false)!.action).toBe("environment");
    // Produção: support first, resuming only once support confirms.
    expect(captureMessage("FISCAL_TRANSPORT_DISABLED", true)!.todo).toMatch(
      /^Fale com o suporte da Freecorps e retome a captura só depois/,
    );
    expect(
      forOrigin(captureMessage("FISCAL_TRANSPORT_DISABLED", true)!, {
        kind: "integration",
        integration: "ERP Serra",
      }).todo,
    ).toBe(
      "Fale com o suporte da Freecorps e espere a confirmação da correção. A integração “ERP Serra” precisa retomar a captura, com a ação resume em POST /v1/connections/nfe. Os documentos recebidos continuam disponíveis.",
    );
    expect(captureMessage("SOURCE_589", true)!.action).toBe("support");
    expect(captureMessage("SOURCE_108", true)!.action).toBe("wait");
    expect(captureMessage("UNHEARD_OF", true)!.action).toBe("support");
  });
  it("as recusas da liberação também ficam aqui", () => {
    expect(releaseFailureText("CAPTURE_RELEASE_INTERVAL_INVALID")).toBe(
      "Escolha um intervalo entre 1 e 24 horas.",
    );
    expect(releaseFailureText("UNHEARD_OF")).toMatch(/Não foi possível concluir/);
  });
});

describe("situação e últimas consultas (#433)", () => {
  it("um só vocabulário para o painel e para os selos da captura fiscal", () => {
    expect(captureSituation("active")).toEqual({
      label: "Captura ativa",
      fiscal: "Captura fiscal ativa",
      tone: "success",
    });
    expect(captureSituation("paused").fiscal).toBe("Captura fiscal pausada");
    expect(captureSituation("attention")).toMatchObject({
      fiscal: "Captura fiscal precisa de atenção",
      tone: "warning",
    });
  });
  it("diz o resultado de cada consulta sem jargão, nos dois ambientes", () => {
    const entry = (outcome: string, status: string | null = null, code: string | null = null) =>
      ({ kind: "query", outcome, status, code }) as Parameters<typeof queryOutcome>[0];
    for (const production of [true, false]) {
      const all = [
        queryOutcome(entry("answered", "138"), production),
        queryOutcome(entry("answered", "137"), production),
        queryOutcome(entry("refused", "656"), production),
        queryOutcome(entry("refused", "108"), production),
        queryOutcome(entry("refused", "589"), production),
        queryOutcome(entry("not-sent", null, "CERTIFICATE_UNAVAILABLE"), production),
        queryOutcome(entry("not-sent"), production),
        queryOutcome(entry("stopped", null, "FISCAL_TRANSPORT_DISABLED"), production),
        queryOutcome(entry("unanswered"), production),
        queryOutcome(entry("running"), production),
      ];
      for (const { result, detail } of all) {
        expect(result).toBeTruthy();
        expect(`${result} ${detail ?? ""}`).not.toMatch(/\bNSU\b|cursor|stream|lote|envelope/i);
      }
    }
    expect(queryOutcome(entry("refused", "656"), true).result).toBe("Bloqueada por uma hora");
    expect(queryOutcome(entry("refused", "108"), true).result).toBe(
      "Receita fora do ar (código 108)",
    );
    expect(queryOutcome(entry("refused", "108"), false).result).toBe(
      "Fonte de teste fora do ar (código 108)",
    );
    expect(queryOutcome(entry("not-sent"), true).detail).toBe("Nada chegou à Receita.");
  });
});
