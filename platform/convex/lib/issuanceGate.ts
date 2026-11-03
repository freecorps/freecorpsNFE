import { deny } from "./organizationAccess";

/**
 * Validation of a production gate change (ADR 0004 §8, amendments of 21/10/2026). Every change
 * comes from a protected GitHub workflow:
 *
 * - `enable`: whoever triggered this run or attempt (`operator`, the `github.triggering_actor`),
 *   a different reviewer who approved it (`approver`), the run id and attempt.
 * - `emergency_disable`: a separate workflow, without approval, that one authorized person
 *   triggers; operator, reason, run id and attempt, the approver only if there was one.
 *
 * Nothing inside Convex proves that a call came from the workflow: anyone with the deploy key or
 * dashboard access of the deployment can call the internal mutation with made-up fields. The
 * control is operational (see ISSUANCE.md, Gate de produção).
 */
export type GateKind = "enable" | "emergency_disable";
export type GateRequest = {
  kind: GateKind;
  operator: string;
  actor?: string;
  approver?: string;
  reason: string;
  runId: string;
  runAttempt: number;
};

/**
 * Actor written to the records the customer sees (operational audit, current gate state,
 * certificate audit of the probe). The GitHub logins of the Freecorps team stay only in
 * `issuanceGateEvents`, the history of Freecorps itself.
 */
export const FREECORPS_OPERATOR = "operator:freecorps";

/** GitHub login: 1 to 39 letters, digits or single hyphens, not at either end. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** Whether `value` is a GitHub login, the name an operator action records. */
export const isOperatorLogin = (value: string) => GITHUB_LOGIN.test(value);
const RUN_ID = /^[1-9]\d{0,19}$/;

/**
 * Characters an audited text never carries: C0 controls and DEL, C1 controls (U+0080 to U+009F)
 * and every bidirectional control of Unicode (`Bidi_Control`: U+061C, U+200E, U+200F, U+202A to
 * U+202E, U+2066 to U+2069), which could make a reason read differently from what was stored.
 */
export function hasUnsafeText(value: string) {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x061c ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    )
      return true;
  }
  return false;
}

/**
 * The person and the reason of an operator action (the gate, the transport probe): a GitHub login
 * and 10 to 500 characters of safe text. Anything else is `INVALID_REQUEST`.
 */
export function operatorAndReason(args: { operator: string; reason: string }) {
  const operator = args.operator.trim();
  const reason = args.reason.trim();
  if (!GITHUB_LOGIN.test(operator)) return deny("INVALID_REQUEST");
  if (reason.length < 10 || reason.length > 500 || hasUnsafeText(reason))
    return deny("INVALID_REQUEST");
  return { operator, reason };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function gateRequest(args: GateRequest) {
  const { operator, reason } = operatorAndReason(args);
  const actor = args.actor?.trim();
  if (actor !== undefined && !GITHUB_LOGIN.test(actor)) return deny("INVALID_REQUEST");
  const runId = args.runId.trim();
  if (!RUN_ID.test(runId)) return deny("ISSUANCE_GATE_RUN_INVALID");
  if (!Number.isSafeInteger(args.runAttempt) || args.runAttempt < 1 || args.runAttempt > 10_000)
    return deny("ISSUANCE_GATE_RUN_INVALID");
  const approver = args.approver?.trim();
  if (approver !== undefined && !GITHUB_LOGIN.test(approver))
    return deny("ISSUANCE_GATE_APPROVER_INVALID");
  // Turning it on takes two different people: the approver is neither who triggered this attempt
  // nor who dispatched the original run, if that was someone else.
  if (
    args.kind === "enable" &&
    (approver === undefined ||
      same(approver, operator) ||
      (actor !== undefined && same(approver, actor)))
  )
    return deny("ISSUANCE_GATE_APPROVER_INVALID");
  return {
    kind: args.kind,
    production: args.kind === "enable",
    operator,
    // `github.actor`, who dispatched the original run, only when it differs from the operator.
    ...(actor !== undefined && !same(actor, operator) ? { actor } : {}),
    ...(approver !== undefined ? { approver } : {}),
    reason,
    runId,
    runAttempt: args.runAttempt,
  };
}
