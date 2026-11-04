import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  digestMail,
  mailHeaders,
  mailSignature,
  MAINTENANCE_HELD_HEADER,
  MAX_MAIL_BYTES,
  ORIGINAL_MIME,
  PRIVACY_PATH,
  readMail,
  recipient,
  sameSignature,
  SIGNATURE_WINDOW,
} from "./lib/privacyMailProtocol";
// freecorps-access: assinatura — e-mail recebido, assinatura do remetente conferida antes do sweep
export const receive = httpAction(async (ctx, request) => {
  const secret = process.env.INBOUND_EMAIL_SECRET;
  if (!secret) return new Response("Indisponível", { status: 503 });
  const field = (key: keyof typeof mailHeaders) => request.headers.get(mailHeaders[key]) ?? "";
  const fields = {
    timestamp: field("timestamp"),
    key: field("key"),
    from: field("from"),
    to: field("to"),
  };
  const time = Number(fields.timestamp);
  const maintenance = new URL(request.url).pathname === PRIVACY_PATH + "/maintenance";
  if (
    !/^\d{13}$/.test(fields.timestamp) ||
    !Number.isFinite(time) ||
    Math.abs(Date.now() - time) > SIGNATURE_WINDOW
  )
    return new Response("Não autorizado", { status: 401 });
  if (Number(request.headers.get("content-length")) > MAX_MAIL_BYTES)
    return new Response("Mensagem muito grande", { status: 413 });
  let bytes: ArrayBuffer;
  try {
    bytes = maintenance && !request.body ? new ArrayBuffer(0) : await readMail(request.body);
  } catch {
    return new Response("Mensagem inválida", { status: 413 });
  }
  const hash = await digestMail(bytes);
  if (!sameSignature(field("signature"), await mailSignature(secret, { ...fields, hash })))
    return new Response("Não autorizado", { status: 401 });
  if (maintenance) {
    if (fields.key !== "maintenance" || bytes.byteLength !== 0)
      return new Response("Inválido", { status: 400 });
    const { held } = await ctx.runMutation(internal.privacyMail.sweep, {});
    return new Response(null, {
      status: 204,
      headers: held ? { [MAINTENANCE_HELD_HEADER]: "1" } : {},
    });
  }
  if (
    !/^pending\/\d{4}-\d{2}-\d{2}\/[a-f0-9-]{36}\.eml$/.test(fields.key) ||
    fields.from.length > 254 ||
    recipient(fields.to) === false
  )
    return new Response("Mensagem inválida", { status: 400 });
  const existing = await ctx.runQuery(internal.privacyMail.intake, { key: fields.key });
  if (existing) {
    return new Response(null, {
      status:
        existing.hash === hash && existing.from === fields.from && existing.to === fields.to
          ? 204
          : 409,
    });
  }
  const raw = await ctx.storage.store(new Blob([bytes], { type: ORIGINAL_MIME }));
  try {
    const saved = await ctx.runMutation(internal.privacyMail.recordIntake, {
      key: fields.key,
      from: fields.from,
      to: fields.to,
      hash,
      raw,
    });
    if (saved !== "stored") await ctx.storage.delete(raw);
    if (saved === "conflict") return new Response(null, { status: 409 });
  } catch {
    // An interrupted call may already have committed: the intake decides, in one transaction.
    // Keep the original only if it took this copy; if this fails too, `collectOrphans` reclaims it.
    try {
      await ctx.runMutation(internal.privacyMail.discardUnclaimed, { key: fields.key, raw });
    } catch {
      // Left to the collector after ORPHAN_GRACE.
    }
    return new Response("Não foi possível guardar", { status: 503 });
  }
  return new Response(null, { status: 204 });
});
// freecorps-access: ticket — o token de download é resgatado por privacyMail.redeem
export const file = httpAction(async (ctx, request) => {
  const token = new URL(request.url).pathname.split("/").at(-1) ?? "";
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (!/^[a-f0-9]{32}$/.test(token))
    return new Response("Não encontrado", { status: 404, headers });
  const id = await ctx.runMutation(internal.privacyMail.redeem, { token });
  const blob = id ? await ctx.storage.get(id) : null;
  if (!blob) return new Response("Não encontrado", { status: 404, headers });
  return new Response(blob, {
    headers: {
      ...headers,
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="mensagem.eml"',
    },
  });
});
