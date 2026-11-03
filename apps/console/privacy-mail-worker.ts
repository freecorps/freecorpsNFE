import type {
  R2Bucket,
  ForwardableEmailMessage,
  ExecutionContext,
  ExportedHandler,
} from "@cloudflare/workers-types";
import {
  digestMail,
  MAINTENANCE_HELD_HEADER,
  mailHeaders,
  mailSignature,
  MAX_MAIL_BYTES,
  PRIVACY_PATH,
  readMail,
  recipient,
} from "../../platform/convex/lib/privacyMailProtocol";

export interface PrivacyMailEnv {
  INBOUND_MAIL: R2Bucket;
  INBOUND_EMAIL_SECRET: string;
  BACKEND_SITE_URL: string;
}
type Metadata = { from: string; to: string };
export async function deliver(
  env: PrivacyMailEnv,
  key: string,
  bytes: ArrayBuffer,
  meta: Metadata,
) {
  try {
    const target = new URL(PRIVACY_PATH, env.BACKEND_SITE_URL);
    if (target.protocol !== "https:" && target.hostname !== "127.0.0.1") return false;
    if (!env.INBOUND_EMAIL_SECRET) return false;
    const fields = { ...meta, key, timestamp: String(Date.now()), hash: await digestMail(bytes) };
    const response = await fetch(target, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "content-type": "message/rfc822",
        [mailHeaders.timestamp]: fields.timestamp,
        [mailHeaders.key]: key,
        [mailHeaders.from]: meta.from,
        [mailHeaders.to]: meta.to,
        [mailHeaders.signature]: await mailSignature(env.INBOUND_EMAIL_SECRET, fields),
      },
      body: bytes,
    });
    await response.body?.cancel();
    if (!response.ok) return false;
    await env.INBOUND_MAIL.delete(key);
    return true;
  } catch {
    return false;
  }
}
export async function receive(
  message: ForwardableEmailMessage,
  env: PrivacyMailEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
) {
  if (recipient(message.to) === false) return message.setReject("Destinatário desconhecido.");
  if (message.rawSize > MAX_MAIL_BYTES) return message.setReject("A mensagem deve ter até 20 MiB.");
  if (!env.INBOUND_MAIL || !env.INBOUND_EMAIL_SECRET || !env.BACKEND_SITE_URL)
    return message.setReject("Caixa indisponível. Tente novamente mais tarde.");
  let bytes: ArrayBuffer;
  try {
    bytes = await readMail(message.raw);
  } catch {
    return message.setReject("Não foi possível receber a mensagem. Limite de 20 MiB.");
  }
  const key = `pending/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.eml`;
  const meta = { from: message.from, to: message.to };
  try {
    await env.INBOUND_MAIL.put(key, bytes, { customMetadata: meta });
  } catch {
    return message.setReject("Caixa indisponível. Tente novamente mais tarde.");
  }
  // Acceptance depends on durable R2 storage, never on the backend being available.
  ctx.waitUntil(deliver(env, key, bytes, meta));
}
export async function drain(env: PrivacyMailEnv) {
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const listed = await env.INBOUND_MAIL.list({
      prefix: "pending/",
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
    for (const entry of listed.objects) {
      if (Date.now() - entry.uploaded.getTime() < 120_000) continue;
      try {
        const object = await env.INBOUND_MAIL.get(entry.key);
        if (!object) continue;
        const meta = {
          from: object.customMetadata?.from ?? "",
          to: object.customMetadata?.to ?? "",
        };
        const bytes = await object.arrayBuffer();
        if (Date.now() - entry.uploaded.getTime() >= 24 * 3_600_000) {
          await env.INBOUND_MAIL.put(entry.key.replace(/^pending\//, "failed/"), bytes, {
            customMetadata: meta,
          });
          await env.INBOUND_MAIL.delete(entry.key);
          console.error("privacy-mail: mensagem retida para recuperação manual");
        } else await deliver(env, entry.key, bytes, meta);
      } catch {
        console.error("privacy-mail: falha na fila, mensagem preservada");
      }
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  const fields = {
    timestamp: String(Date.now()),
    key: "maintenance",
    from: "",
    to: "",
    hash: await digestMail(new ArrayBuffer(0)),
  };
  const response = await fetch(new URL(PRIVACY_PATH + "/maintenance", env.BACKEND_SITE_URL), {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers: {
      [mailHeaders.timestamp]: fields.timestamp,
      [mailHeaders.key]: fields.key,
      [mailHeaders.from]: "",
      [mailHeaders.to]: "",
      [mailHeaders.signature]: await mailSignature(env.INBOUND_EMAIL_SECRET, fields),
    },
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error("privacy-mail: manutenção não confirmada");
  if (response.headers.get(MAINTENANCE_HELD_HEADER) === "1")
    console.error("privacy-mail: coleta de originais retida; conferir privacyMaintenance");
}
export default {
  email: receive,
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(drain(env));
  },
} satisfies ExportedHandler<PrivacyMailEnv>;
