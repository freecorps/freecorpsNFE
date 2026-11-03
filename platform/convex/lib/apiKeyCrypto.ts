/**
 * Geração e hash de API keys. Runtime-agnóstico (Web Crypto — roda no isolate
 * do Convex e em Node). Segredos têm 256 bits de entropia, então SHA-256 puro
 * é suficiente como hash de armazenamento (não precisa de KDF lenta).
 */

export const API_KEY_PREFIX = "fnfe_";

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export function generateApiKeySecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return API_KEY_PREFIX + b64url(bytes);
}

export async function hashApiKey(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function looksLikeApiKey(secret: string): boolean {
  return secret.startsWith(API_KEY_PREFIX) && secret.length >= API_KEY_PREFIX.length + 40;
}
