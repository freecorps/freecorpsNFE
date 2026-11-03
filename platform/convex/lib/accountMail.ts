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
      provider: "cloudflare";
      apiKey: string;
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

/** Email Sending of the Freecorps Cloudflare account, also used by the capture alerts (#422). */
export const CLOUDFLARE_EMAIL_SEND_URL =
  "https://api.cloudflare.com/client/v4/accounts/ceccd1846b474bb179054a3c2c4a6185/email/sending/send";

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
    !config.apiKey ||
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
      await sendCloudflareMail(config, {
        name: accountSenderName(),
        to: [message.email],
        subject,
        text: `${link ? `Abrir o convite: ${link}\n\n` : ""}${label}: ${message.otp}\n\n${instructions}`,
        html: `${link ? `<p><a href="${link}">Abrir o convite</a></p>` : ""}<p>${label}: <strong>${message.otp}</strong></p><p>${instructions}</p>`,
      });
    },
  };
}

/**
 * Hands one message to Email Sending: fixed endpoint, five seconds, no redirect, no retry. It
 * resolves only when the provider answers `success` with every recipient queued or delivered and
 * none bounced; anything else throws a generic error, since a timeout may still have been accepted.
 * The provider body is bounded and never logged. Shared by the account codes and the notice of a
 * new version of the terms of use (#594).
 */
export async function sendCloudflareMail(
  config: { apiKey: string; from: string },
  message: { name: string; to: readonly string[]; subject: string; text: string; html?: string },
) {
  let response: Response;
  try {
    response = await fetch(CLOUDFLARE_EMAIL_SEND_URL, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: { address: config.from, name: message.name },
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      }),
    });
  } catch {
    throw new Error("Account email provider unavailable");
  }
  if (!response.ok) throw new Error("Account email provider rejected delivery");
  // A 2xx alone does not prove recipient acceptance. Never log the provider body.
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(await boundedAuthBody(response)));
  } catch {
    throw new Error("Account email provider response invalid");
  }
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;
  if (!record(data) || data.success !== true || !record(data.result))
    throw new Error("Account email provider response invalid");
  const result = data.result;
  for (const email of message.to) {
    if (Array.isArray(result.permanent_bounces) && result.permanent_bounces.includes(email))
      throw new Error("Account email provider rejected delivery");
    if (
      ![result.delivered, result.queued].some((list) => Array.isArray(list) && list.includes(email))
    )
      throw new Error("Account email provider did not accept recipient");
  }
}
