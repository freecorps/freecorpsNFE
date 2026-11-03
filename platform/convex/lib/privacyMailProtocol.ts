/** Protocol shared by the mail Worker and Convex. No provider or authentication dependencies. */
const DOMAIN = "nfe.freecorps.com.br";
/** Each mailbox has its own address, operators and console page; the pipeline is the same. */
export const MAILBOXES = {
  privacy: { local: "privacidade", sender: "Freecorps Fiscal · Privacidade" },
  security: { local: "seguranca", sender: "Freecorps Fiscal · Segurança" },
  support: { local: "suporte", sender: "Freecorps Fiscal · Suporte" },
  operation: { local: "operacao", sender: "Freecorps Fiscal · Operação" },
} as const;
export type Mailbox = keyof typeof MAILBOXES;
export const mailboxAddress = (mailbox: Mailbox) => `${MAILBOXES[mailbox].local}@${DOMAIN}`;
export const replyAddress = (mailbox: Mailbox, token: string) =>
  `${MAILBOXES[mailbox].local}+t_${token}@${DOMAIN}`;
/** Threads stored before mailboxes were split have no `mailbox`; they belong to privacy. */
export const mailboxOf = (thread: { mailbox?: Mailbox }): Mailbox => thread.mailbox ?? "privacy";
export const PRIVACY_ADDRESS = mailboxAddress("privacy");
export const SECURITY_ADDRESS = mailboxAddress("security");
export const SUPPORT_ADDRESS = mailboxAddress("support");
export const OPERATION_ADDRESS = mailboxAddress("operation");
export const PRIVACY_PATH = "/privacy-mail";
export const MAX_MAIL_BYTES = 20 * 1024 * 1024;
export const SIGNATURE_WINDOW = 5 * 60_000;
/**
 * Content type of the originals stored by the backend. No other flow may use it: the orphan
 * collector deletes any blob of this type that no privacy intake or message references. Blobs
 * stored before it used the generic `message/rfc822`, collected only if older than the
 * collector itself (`privacyMaintenance.legacyUntil`).
 */
export const ORIGINAL_MIME = "application/vnd.freecorps.privacy-mail+rfc822";
export const LEGACY_ORIGINAL_MIME = "message/rfc822";
/**
 * Age after which an original without intake or message is an orphan. Well above the signature
 * window plus the longest a delivery action can run (10 minutes), so the collector never races
 * an intake still being recorded.
 */
export const ORPHAN_GRACE = 60 * 60_000;
/** Set to "1" on the maintenance response while the orphan collector is held. */
export const MAINTENANCE_HELD_HEADER = "x-fnfe-mail-held";
export const mailHeaders = {
  timestamp: "x-fnfe-mail-timestamp",
  key: "x-fnfe-mail-key",
  from: "x-fnfe-mail-from",
  to: "x-fnfe-mail-to",
  signature: "x-fnfe-mail-signature",
} as const;

/** The mailbox and the case token of an accepted recipient; `false` for any other address. */
export function recipient(address: string): { mailbox: Mailbox; token: string | null } | false {
  const match = /^([a-z]+)(?:\+t_([a-f0-9]{32}))?@nfe\.freecorps\.com\.br$/.exec(
    address.trim().toLowerCase(),
  );
  const mailbox = (Object.keys(MAILBOXES) as Mailbox[]).find(
    (name) => MAILBOXES[name].local === match?.[1],
  );
  return mailbox ? { mailbox, token: match?.[2] ?? null } : false;
}
export function validAddress(address: string) {
  return (
    address.length <= 254 &&
    address.split("").every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
    /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)
  );
}
export async function digestMail(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function mailSignature(
  secret: string,
  fields: { timestamp: string; key: string; from: string; to: string; hash: string },
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = JSON.stringify([
    fields.timestamp,
    fields.key,
    fields.from,
    fields.to,
    fields.hash,
  ]);
  return Array.from(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export function sameSignature(a: string, b: string) {
  if (!/^[a-f0-9]{64}$/.test(a) || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
/** Enforce the size on the actual stream, even without Content-Length. */
type MailStream = {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(): Promise<unknown>;
    releaseLock(): void;
  };
};
export async function readMail(stream: MailStream | null): Promise<ArrayBuffer> {
  if (!stream) throw new Error("EMPTY_MAIL");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) throw new Error("INVALID_MAIL_STREAM");
      length += value.byteLength;
      if (length > MAX_MAIL_BYTES) {
        await reader.cancel();
        throw new Error("MAIL_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}
