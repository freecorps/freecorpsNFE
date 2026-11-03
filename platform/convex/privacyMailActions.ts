"use node";
import PostalMime from "postal-mime";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { MAILBOXES, mailboxAddress, mailboxOf, replyAddress } from "./lib/privacyMailProtocol";

export const parse = internalAction({
  args: { intakeId: v.id("privacyIntakes") },
  returns: v.null(),
  handler: async (ctx, { intakeId }) => {
    const intake: Doc<"privacyIntakes"> | null = await ctx.runQuery(
      internal.privacyMail.intakeById,
      { intakeId },
    );
    if (!intake || intake.state === "filed") return null;
    const blob = await ctx.storage.get(intake.raw);
    let subject = "(Mensagem original)",
      text = "Não foi possível interpretar o conteúdo. Baixe o original para consultar a mensagem.";
    let contact = intake.from,
      messageId: string | undefined;
    let attachmentNames: string[] = [];
    if (blob) {
      try {
        const parsed = await PostalMime.parse(await blob.arrayBuffer());
        subject = parsed.subject ?? "(Sem assunto)";
        // No remote images or active HTML. The original preserves HTML and attachments.
        text =
          parsed.text ||
          "Esta mensagem contém apenas HTML. Baixe o original para consultar o conteúdo.";
        contact = parsed.from?.address ?? intake.from;
        messageId = parsed.messageId;
        attachmentNames = parsed.attachments
          .slice(0, 100)
          .map((a) => (a.filename || "anexo").slice(0, 200));
      } catch {
        /* Preserve an unread case even when MIME decoding fails. */
      }
    }
    await ctx.runMutation(internal.privacyMail.file, {
      intakeId,
      subject: subject.slice(0, 500),
      text: text.slice(0, 100_000),
      contact: contact.slice(0, 254),
      attachmentNames,
      ...(messageId ? { messageId: messageId.slice(0, 500) } : {}),
    });
    return null;
  },
});
export const send = internalAction({
  args: { messageId: v.id("privacyMessages") },
  returns: v.null(),
  handler: async (ctx, { messageId }) => {
    const claimed: { message: Doc<"privacyMessages">; thread: Doc<"privacyThreads"> } | null =
      await ctx.runMutation(internal.privacyMail.claimReply, { messageId });
    if (!claimed) return null;
    const box = mailboxOf(claimed.thread);
    let state: "accepted" | "failed" | "uncertain" = "failed";
    const mode = process.env.FNFE_PRIVACY_SEND_MODE;
    if (mode === "local" && process.env.APP_ENV === "development") {
      state = "accepted";
    } else if (
      mode === "cloudflare" &&
      process.env.FNFE_PRIVACY_EMAIL_API_TOKEN &&
      process.env.FNFE_PRIVACY_EMAIL_ACCOUNT_ID
    ) {
      // Once the request may have left, a timeout is uncertain. Never resend automatically.
      state = "uncertain";
      try {
        const response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${process.env.FNFE_PRIVACY_EMAIL_ACCOUNT_ID}/email/sending/send`,
          {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
            headers: {
              authorization: `Bearer ${process.env.FNFE_PRIVACY_EMAIL_API_TOKEN}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              from: {
                address: mailboxAddress(box),
                name: MAILBOXES[box].sender,
              },
              to: [claimed.thread.contact],
              subject: `Re: ${claimed.thread.subject}`,
              text: claimed.message.text,
              reply_to: replyAddress(box, claimed.thread.token),
            }),
          },
        );
        if (response.status >= 400 && response.status < 500) state = "failed";
        else if (response.ok) {
          const data: unknown = await response.json();
          if (
            data &&
            typeof data === "object" &&
            "success" in data &&
            data.success === true &&
            "result" in data &&
            data.result &&
            typeof data.result === "object"
          ) {
            const result = data.result;
            if (
              ("delivered" in result &&
                Array.isArray(result.delivered) &&
                result.delivered.includes(claimed.thread.contact)) ||
              ("queued" in result &&
                Array.isArray(result.queued) &&
                result.queued.includes(claimed.thread.contact))
            )
              state = "accepted";
            else if (
              "permanent_bounces" in result &&
              Array.isArray(result.permanent_bounces) &&
              result.permanent_bounces.includes(claimed.thread.contact)
            )
              state = "failed";
          }
        }
      } catch {
        /* The provider may have accepted it; keep the uncertain state. */
      }
    }
    await ctx.runMutation(internal.privacyMail.finishReply, { messageId, state });
    return null;
  },
});
