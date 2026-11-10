import { EmberMail } from "@freecorps/mail-sdk";
import { boundedAuthBody } from "../../auth-transport";
export interface AccountMessage {
  email: string;
  otp: string;
  type: "email-verification" | "forget-password" | "organization-invitation" | "email-change";
}
export interface AccountMailProvider {
  send(message: AccountMessage): Promise<void>;
}
export type AccountMailConfiguration =
  | { provider: "disabled" }
  | { provider: "local"; capture: (message: AccountMessage) => Promise<unknown> }
  | {
      provider: "remote";
      /** The provider `EMAIL_MODE` chose and its credentials (`mailServiceOf`). */
      service: MailService | null;
      from: string;
      /** `any` only in the installation profile, with `ACCOUNT_EMAIL_RECIPIENTS=*`. */
      allowedRecipients: readonly string[] | "any";
      /** Console origin. Invitations carry a link to it, with the code in the fragment. */
      siteUrl?: string;
    };

/**
 * Invitation link. The code goes in the fragment (`#code=`), which the browser never sends to a
 * server or in a Referer; the console reads it into memory and removes it from the address.
 */
export function invitationLink(siteUrl: string, code: string) {
  const origin = new URL(siteUrl).origin;
  return `${origin}/accept-invitation#code=${code}`;
}

/** Sender name and Better Auth app name: the customers' installation never says "Validação". */
export function accountSenderName() {
  return process.env.APP_ENV === "installation"
    ? "Freecorps Fiscal"
    : "Freecorps Fiscal · Validação";
}

/** Delivery port. Enabling a remote adapter does not grant signup or product access. */
export function createAccountMailProvider(config: AccountMailConfiguration): AccountMailProvider {
  if (config.provider === "disabled")
    return {
      async send() {
        throw new Error("Account email delivery disabled");
      },
    };
  if (config.provider === "local")
    return {
      async send(message) {
        await config.capture(message);
      },
    };
  if (
    !config.service?.apiKey ||
    !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(config.from) ||
    (config.allowedRecipients !== "any" && config.allowedRecipients.length === 0)
  )
    throw new Error(
      "Account email provider requires credentials, a sender and explicit recipients",
    );
  const allowed =
    config.allowedRecipients === "any"
      ? null
      : new Set(config.allowedRecipients.map((value) => value.trim().toLowerCase()));
  return {
    async send(message) {
      if (allowed && !allowed.has(message.email.toLowerCase()))
        throw new Error("Account email recipient not allowed");
      const invitation = message.type === "organization-invitation";
      if (!(invitation ? /^[a-f0-9]{64}$/ : /^\d{8}$/).test(message.otp))
        throw new Error("Invalid account code");
      const verification = message.type === "email-verification";
      const change = message.type === "email-change";
      const subject = invitation
        ? "Convite para uma organização na Freecorps Fiscal"
        : verification
          ? "Verifique seu e-mail na Freecorps Fiscal"
          : change
            ? "Confirme seu novo e-mail na Freecorps Fiscal"
            : "Recuperação de acesso à Freecorps Fiscal";
      const label = invitation
        ? "Seu código de convite"
        : verification
          ? "Seu código de verificação"
          : change
            ? "Seu código para trocar o e-mail"
            : "Seu código de recuperação";
      const link =
        invitation && config.siteUrl ? invitationLink(config.siteUrl, message.otp) : null;
      const instructions = invitation
        ? `${link ? "Abra o link do convite e entre com este e-mail verificado. Se preferir, entre no painel, escolha Aceitar convite e cole o código. " : "Entre no painel com este e-mail verificado e escolha Aceitar convite. "}Confira a organização e o papel antes de aceitar. Válido por 72 horas, para um único uso.`
        : "Válido por dez minutos, para um único uso. Se você não solicitou esta mensagem, ignore-a.";
      await sendAccountMail(
        { service: config.service, from: config.from },
        {
          name: accountSenderName(),
          to: [message.email],
          subject,
          text: `${link ? `Abrir o convite: ${link}\n\n` : ""}${label}: ${message.otp}\n\n${instructions}`,
          html: `${link ? `<p><a href="${link}">Abrir o convite</a></p>` : ""}<p>${label}: <strong>${message.otp}</strong></p><p>${instructions}</p>`,
        },
      );
    },
  };
}

/**
 * The provider `EMAIL_MODE` chose: Email Sending of a Cloudflare account, called directly
 * (`cloudflare`), or an Ember Mail (`mail`, freecorps/mail), which owns queue, retries, delivery
 * events and suppressions. The operator chooses; Freecorps uses `mail`.
 */
export type MailService =
  | { provider: "cloudflare"; accountId: string; apiKey: string }
  | { provider: "mail"; apiUrl: string; apiKey: string };

export type MailMessage = {
  from: string;
  name: string;
  to: readonly string[];
  subject: string;
  text: string;
  html?: string;
  /** Ember Mail: same key, same e-mail, so a retried call sends once. Email Sending has none. */
  idempotencyKey?: string;
};

/**
 * Hands one message to the provider. `sent` once it accepted the message, `failed` when it refused
 * it (4xx, or a permanent bounce: nothing went out), `uncertain` on a timeout, a 5xx, no answer or an
 * unreadable one, since it may have been accepted. The answer body is never logged.
 */
export async function deliverMail(
  service: MailService,
  message: MailMessage,
  options: { timeoutMs: number; retries: number },
): Promise<"sent" | "failed" | "uncertain"> {
  return service.provider === "mail"
    ? await deliverEmberMail(service, message, options)
    : await deliverEmailSending(service, message, options.timeoutMs);
}

async function deliverEmberMail(
  service: Extract<MailService, { provider: "mail" }>,
  message: MailMessage,
  options: { timeoutMs: number; retries: number },
) {
  const mail = new EmberMail(service.apiKey, {
    baseUrl: service.apiUrl,
    timeoutMs: options.timeoutMs,
    retries: options.retries,
  });
  const { error } = await mail.emails.send(
    {
      from: `${quotedName(message.name)} <${message.from}>`,
      to: [...message.to],
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    },
    message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : {},
  );
  if (!error) return "sent";
  return error.outcome === "not_sent" ? "failed" : "uncertain";
}

/** The Email Sending endpoint of one Cloudflare account. */
export const emailSendingUrl = (accountId: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`;

/**
 * Email Sending's REST API: fixed endpoint, no redirect, no retry. `sent` only when it answers
 * `success` with every recipient queued or delivered and none bounced. The body is bounded.
 */
async function deliverEmailSending(
  service: Extract<MailService, { provider: "cloudflare" }>,
  message: MailMessage,
  timeoutMs: number,
): Promise<"sent" | "failed" | "uncertain"> {
  let response: Response;
  try {
    response = await fetch(emailSendingUrl(service.accountId), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${service.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: { address: message.from, name: message.name },
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      }),
    });
  } catch {
    return "uncertain";
  }
  if (response.status >= 400 && response.status < 500) return "failed";
  if (!response.ok) return "uncertain";
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(await boundedAuthBody(response)));
  } catch {
    return "uncertain";
  }
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;
  if (!record(data) || data.success !== true || !record(data.result)) return "uncertain";
  const result = data.result;
  for (const email of message.to) {
    if (Array.isArray(result.permanent_bounces) && result.permanent_bounces.includes(email))
      return "failed";
    if (
      ![result.delivered, result.queued].some((list) => Array.isArray(list) && list.includes(email))
    )
      return "uncertain";
  }
  return "sent";
}

/** A display name the service parses: quoted, without quotes, backslashes or line breaks. */
function quotedName(name: string) {
  return `"${name.replace(/["\\\r\n]/g, "").trim()}"`;
}

/**
 * Account codes and notices: five seconds, no retry (the person asks for a new code). Resolves only
 * once the provider accepted the message; anything else throws a generic error, since a timeout may
 * still have been accepted. Shared by the account codes and the notices of a new version of the
 * terms of use (#594) and of the archive (ADR 0009).
 */
export async function sendAccountMail(
  config: { service: MailService | null; from: string },
  message: { name: string; to: readonly string[]; subject: string; text: string; html?: string },
) {
  if (!config.service) throw new Error("Account email delivery disabled");
  const delivery = await deliverMail(
    config.service,
    { from: config.from, ...message },
    { timeoutMs: 5000, retries: 0 },
  );
  if (delivery === "failed") throw new Error("Account email provider rejected delivery");
  if (delivery === "uncertain") throw new Error("Account email provider unavailable");
}
