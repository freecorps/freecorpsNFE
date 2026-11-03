export const authProxyHeaders = {
  ip: "x-fnfe-auth-ip",
  time: "x-fnfe-auth-time",
  signature: "x-fnfe-auth-signature",
} as const;
const encoder = new TextEncoder();
const maxBytes = 32 * 1024;

export async function boundedAuthBody(request: Pick<Request, "body">): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new Error("Auth payload too large");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function clientIp(value: string | null): string | null {
  if (!value || value.length > 45 || /[^a-fA-F0-9.:]/.test(value)) return null;
  if (!value.includes(":")) {
    const parts = value.split(".");
    return parts.length === 4 &&
      parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
      ? value
      : null;
  }
  try {
    return new URL(`http://[${value}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

/** IPv6 users share a /64 bucket, so rotating the interface identifier does not reset limits. */
export function ipBucket(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [left, right = ""] = ip.split("::");
  const a = left ? left.split(":") : [];
  const b = right ? right.split(":") : [];
  const full = ip.includes("::")
    ? [...a, ...Array<string>(8 - a.length - b.length).fill("0"), ...b]
    : a;
  return (
    full
      .slice(0, 4)
      .map((part) => part.padStart(4, "0"))
      .join(":") + "::/64"
  );
}

export async function digest(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function key(secret: string) {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error("Invalid proxy configuration");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
async function payload(request: Request, body: Uint8Array, ip: string, time: string) {
  const url = new URL(request.url);
  return encoder.encode(
    JSON.stringify([
      request.method,
      url.pathname + url.search,
      request.headers.get("origin"),
      ip,
      time,
      await digest(body),
    ]),
  );
}
export async function signAuthRequest(
  request: Request,
  body: Uint8Array,
  ip: string,
  secret: string,
  now = Date.now(),
) {
  const time = String(now);
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(secret),
    await payload(request, body, ip, time),
  );
  return {
    [authProxyHeaders.ip]: ip,
    [authProxyHeaders.time]: time,
    [authProxyHeaders.signature]: Array.from(new Uint8Array(signature), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
  };
}
export async function verifyAuthRequest(
  request: Request,
  body: Uint8Array,
  secret: string,
  now = Date.now(),
): Promise<string | null> {
  const ip = clientIp(request.headers.get(authProxyHeaders.ip));
  const time = request.headers.get(authProxyHeaders.time) ?? "";
  const signature = request.headers.get(authProxyHeaders.signature) ?? "";
  if (
    !ip ||
    !/^\d{13}$/.test(time) ||
    Math.abs(now - Number(time)) > 30_000 ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return null;
  const bytes = Uint8Array.from(signature.match(/../g)!, (part) => Number.parseInt(part, 16));
  return (await crypto.subtle.verify(
    "HMAC",
    await key(secret),
    bytes,
    await payload(request, body, ip, time),
  ))
    ? ip
    : null;
}

/** REST calls through the Worker. The body is not signed so uploads and downloads stream. */
export const apiProxyHeaders = {
  ip: "x-fnfe-api-ip",
  time: "x-fnfe-api-time",
  signature: "x-fnfe-api-signature",
} as const;
function apiPayload(request: Pick<Request, "method" | "url">, ip: string, time: string) {
  const url = new URL(request.url);
  // The "api" tag keeps these signatures from being replayed as auth signatures and vice versa.
  return encoder.encode(
    JSON.stringify(["api", request.method, url.pathname + url.search, ip, time]),
  );
}
export async function signApiRequest(
  request: Pick<Request, "method" | "url">,
  ip: string,
  secret: string,
  now = Date.now(),
) {
  const time = String(now);
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(secret),
    apiPayload(request, ip, time),
  );
  return {
    [apiProxyHeaders.ip]: ip,
    [apiProxyHeaders.time]: time,
    [apiProxyHeaders.signature]: Array.from(new Uint8Array(signature), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
  };
}
export async function verifyApiRequest(
  request: Pick<Request, "method" | "url" | "headers">,
  secret: string,
  now = Date.now(),
): Promise<string | null> {
  const ip = clientIp(request.headers.get(apiProxyHeaders.ip));
  const time = request.headers.get(apiProxyHeaders.time) ?? "";
  const signature = request.headers.get(apiProxyHeaders.signature) ?? "";
  if (
    !ip ||
    !/^\d{13}$/.test(time) ||
    Math.abs(now - Number(time)) > 30_000 ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return null;
  const bytes = Uint8Array.from(signature.match(/../g)!, (part) => Number.parseInt(part, 16));
  return (await crypto.subtle.verify(
    "HMAC",
    await key(secret),
    bytes,
    apiPayload(request, ip, time),
  ))
    ? ip
    : null;
}
