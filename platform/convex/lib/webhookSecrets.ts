/** Ciphertext stays in internal tables. A dedicated deployment key protects endpoint secrets. */
async function master() {
  const source = process.env.FNFE_WEBHOOK_MASTER_KEY;
  if (!source || !/^[a-f0-9]{64}$/.test(source))
    throw new Error("Webhook encryption is not configured");
  const raw = Uint8Array.from(source.match(/../g)!, (b) => parseInt(b, 16));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptSecret(secret: string, context: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    await master(),
    new TextEncoder().encode(secret),
  );
  return [iv, new Uint8Array(data)]
    .map((b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""))
    .join(":");
}
export async function decryptSecret(cipher: string, context: string) {
  const parts = cipher
    .split(":")
    .map((p) => Uint8Array.from(p.match(/../g) ?? [], (b) => parseInt(b, 16)));
  const data = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: parts[0]!, additionalData: new TextEncoder().encode(context) },
    await master(),
    parts[1]!,
  );
  return new TextDecoder().decode(data);
}
export function newWebhookSecret() {
  return `whsec_${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
