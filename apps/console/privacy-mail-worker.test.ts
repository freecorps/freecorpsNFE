import type { R2Bucket, ForwardableEmailMessage } from "@cloudflare/workers-types";
import { afterAll, afterEach, expect, it, vi } from "vite-plus/test";
import { receive, deliver, drain, type PrivacyMailEnv } from "./privacy-mail-worker";
import {
  PRIVACY_ADDRESS,
  SECURITY_ADDRESS,
  MAX_MAIL_BYTES,
  mailHeaders,
  digestMail,
  mailSignature,
  MAINTENANCE_HELD_HEADER,
} from "../../platform/convex/lib/privacyMailProtocol";

// Relógio fixo: as fixtures são relativas a este instante, longe de virada de dia e de mês
// (freecorps/no-wall-clock-in-tests).
vi.setSystemTime(new Date("2026-06-15T15:00:00Z"));
afterAll(() => vi.useRealTimers());

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const entries = new Map<
    string,
    { bytes: ArrayBuffer; meta: Record<string, string>; uploaded: Date }
  >();
  const put = vi.fn(
    async (
      key: string,
      bytes: ArrayBuffer,
      options?: { customMetadata?: Record<string, string> },
    ) => {
      entries.set(key, { bytes, meta: options?.customMetadata ?? {}, uploaded: new Date() });
    },
  );
  const bucket = {
    put,
    delete: vi.fn(async (key: string) => {
      entries.delete(key);
    }),
    get: vi.fn(async (key: string) => {
      const row = entries.get(key);
      return row
        ? {
            key,
            uploaded: row.uploaded,
            customMetadata: row.meta,
            arrayBuffer: async () => row.bytes,
          }
        : null;
    }),
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({
      objects: [...entries.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, row]) => ({ key, uploaded: row.uploaded })),
      truncated: false,
    })),
  };
  const env: PrivacyMailEnv = {
    INBOUND_MAIL: bucket as unknown as R2Bucket,
    INBOUND_EMAIL_SECRET: "synthetic-worker-secret",
    BACKEND_SITE_URL: "https://backend.example",
  };
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      tasks.push(promise);
    },
  };
  const message = (body = "Synthetic mail", to = PRIVACY_ADDRESS) =>
    ({
      raw: new Response(body).body!,
      rawSize: body.length,
      to,
      from: "synthetic@example.com",
      setReject: vi.fn(),
    }) as unknown as ForwardableEmailMessage & { setReject: ReturnType<typeof vi.fn> };
  return { entries, bucket, env, ctx, tasks, message };
}
it("accepts only after durable storage, retains mail on backend failure and signs envelope plus bytes", async () => {
  const f = fixture();
  const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
    expect(f.entries.size).toBe(1);
    const headers = new Headers(init!.headers),
      bytes = init!.body as ArrayBuffer;
    expect(headers.get(mailHeaders.signature)).toBe(
      await mailSignature(f.env.INBOUND_EMAIL_SECRET, {
        timestamp: headers.get(mailHeaders.timestamp)!,
        key: headers.get(mailHeaders.key)!,
        from: "synthetic@example.com",
        to: PRIVACY_ADDRESS,
        hash: await digestMail(bytes),
      }),
    );
    return new Response("down", { status: 503 });
  });
  vi.stubGlobal("fetch", fetchMock);
  const message = f.message();
  await receive(message, f.env, f.ctx);
  await Promise.all(f.tasks);
  expect(message.setReject).not.toHaveBeenCalled();
  expect(f.entries.size).toBe(1);
  expect(f.bucket.delete).not.toHaveBeenCalled();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  const [key, row] = [...f.entries][0]!;
  expect(
    await deliver(f.env, key, row.bytes, { from: "synthetic@example.com", to: PRIVACY_ADDRESS }),
  ).toBe(true);
  expect(f.entries.size).toBe(0);
});
it("accepts the security, support and operation addresses and their case tokens through the same queue", async () => {
  const f = fixture();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  for (const to of [
    SECURITY_ADDRESS,
    `seguranca+t_${"a".repeat(32)}@nfe.freecorps.com.br`,
    "suporte@nfe.freecorps.com.br",
    `suporte+t_${"b".repeat(32)}@nfe.freecorps.com.br`,
    "operacao@nfe.freecorps.com.br",
    `operacao+t_${"c".repeat(32)}@nfe.freecorps.com.br`,
  ]) {
    const message = f.message("Synthetic report", to);
    await receive(message, f.env, f.ctx);
    expect(message.setReject).not.toHaveBeenCalled();
  }
  await Promise.all(f.tasks);
  expect(f.entries.size).toBe(0);
});
it("rejects unknown domains, oversized streams and failed R2 writes without attempting delivery", async () => {
  const f = fixture();
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  for (const message of [
    f.message("test", "privacidade@other.example"),
    f.message("test", "contato@nfe.freecorps.com.br"),
    f.message("test", "seguranca+t_short@nfe.freecorps.com.br"),
    f.message("test", "suporte+t_short@nfe.freecorps.com.br"),
    f.message("test", "operacao+t_short@nfe.freecorps.com.br"),
    f.message("x".repeat(MAX_MAIL_BYTES + 1)),
  ]) {
    await receive(message, f.env, f.ctx);
    expect(message.setReject).toHaveBeenCalled();
  }
  const hiddenSize = f.message("x".repeat(MAX_MAIL_BYTES + 1));
  Object.defineProperty(hiddenSize, "rawSize", { value: 1 });
  await receive(hiddenSize, f.env, f.ctx);
  expect(hiddenSize.setReject).toHaveBeenCalled();
  f.bucket.put.mockRejectedValueOnce(new Error("R2 down"));
  const message = f.message();
  await receive(message, f.env, f.ctx);
  expect(message.setReject).toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});
it("retries old pending mail, preserves failed mail and invokes signed maintenance", async () => {
  const f = fixture();
  for (const [key, age] of [
    ["pending/old.eml", 25 * 3600_000],
    ["pending/retry.eml", 180_000],
  ] as const)
    f.entries.set(key, {
      bytes: new TextEncoder().encode("synthetic").buffer,
      meta: { from: "synthetic@example.com", to: PRIVACY_ADDRESS },
      uploaded: new Date(Date.now() - age),
    });
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await drain(f.env);
  } finally {
    error.mockRestore();
  }
  expect(f.entries.has("failed/old.eml")).toBe(true);
  expect(f.entries.has("pending/old.eml")).toBe(false);
  expect(f.entries.has("pending/retry.eml")).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(String(fetchMock.mock.calls[1]![0])).toBe(
    "https://backend.example/privacy-mail/maintenance",
  );
});
it("alerts without content when the backend reports the orphan collector as held", async () => {
  const f = fixture();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await drain(f.env);
    expect(error).not.toHaveBeenCalled();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(null, { status: 204, headers: { [MAINTENANCE_HELD_HEADER]: "1" } }),
        ),
    );
    await drain(f.env);
    expect(error).toHaveBeenCalledWith(
      "privacy-mail: coleta de originais retida; conferir privacyMaintenance",
    );
  } finally {
    error.mockRestore();
  }
});
