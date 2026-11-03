import { components } from "../_generated/api";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { deny, requireUser } from "./organizationAccess";
import type { Mailbox } from "./privacyMailProtocol";

/** Each mailbox has its own allowlist; being allowed in one grants nothing in the others. */
const operatorVariables: Record<Mailbox, string> = {
  privacy: "FNFE_PRIVACY_OPERATOR_EMAILS",
  security: "FNFE_SECURITY_OPERATOR_EMAILS",
  support: "FNFE_SUPPORT_OPERATOR_EMAILS",
  operation: "FNFE_OPERATION_OPERATOR_EMAILS",
};
export function mailboxEmailAllowed(mailbox: Mailbox, email: string) {
  return (process.env[operatorVariables[mailbox]] ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}
export async function requireMailboxOperator(ctx: QueryCtx | MutationCtx, mailbox: Mailbox) {
  const user = await requireUser(ctx);
  if (!mailboxEmailAllowed(mailbox, user.email)) deny();
  return user;
}
/** Scheduled work and download tickets must observe a revoked operator too. */
export async function mailboxActorAllowed(
  ctx: Pick<QueryCtx | MutationCtx | ActionCtx, "runQuery">,
  mailbox: Mailbox,
  actorId: string,
) {
  const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "user",
    where: [{ field: "_id", value: actorId }],
  });
  return (
    !!user &&
    "email" in user &&
    "emailVerified" in user &&
    user.emailVerified === true &&
    typeof user.email === "string" &&
    mailboxEmailAllowed(mailbox, user.email)
  );
}
