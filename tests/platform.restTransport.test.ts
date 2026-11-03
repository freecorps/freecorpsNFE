/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { parseRequest } from "../packages/contracts/src/external";
import schema from "../platform/convex/schema";
import { internal } from "../platform/convex/_generated/api";
import { register } from "../platform/test-setup";
import { hashApiKey } from "../platform/convex/lib/apiKeyCrypto";
import { jsonAnswer } from "../platform/convex/lib/externalHttp";
import { publicError } from "../platform/convex/lib/publicErrors";

const modules = import.meta.glob("../platform/convex/**/*.ts");
beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  for (const [k, v] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5200",
    CONVEX_SITE_URL: "http://127.0.0.1:3259",
    BETTER_AUTH_SECRET: "synthetic-transport-secret-offline",
    FNFE_WEBHOOK_MASTER_KEY: "ab".repeat(32),
  }))
    vi.stubEnv(k, v);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function fixture() {
  const t = convexTest(schema, modules);
  register(t);
  const secret = `fnfe_${"a".repeat(43)}`;
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash: await hashApiKey(secret),
    suffix: crypto.randomUUID(),
  });
  const call = async (
    path: string,
    init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {},
    auth = true,
  ) => {
    const response = await t.fetch(path, {
      ...init,
      headers: {
        ...(auth ? { Authorization: `Bearer ${secret}` } : {}),
        "X-Environment": "sandbox",
        "Idempotency-Key": "synthetic-transport",
        "X-Request-Id": "caller-chosen",
        ...init.headers,
      },
    });
    const body = await response.json();
    // Every answer carries the server reference, in the body and in the header.
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get("X-Request-Id")).toBe(body.requestId);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    return { status: response.status, body };
  };
  return { t, scope, call };
}

it("recusa chave ausente ou malformada antes de ler o corpo", async () => {
  const f = await fixture();
  for (const headers of [{}, { Authorization: "Bearer fnfe_curta" }] as Record<string, string>[]) {
    const result = await f.call(
      "/v1/imports",
      { method: "POST", headers, body: "{não é json" },
      false,
    );
    expect(result.status).toBe(401);
    expect(result.body.error).toEqual({
      code: "INVALID_API_KEY",
      message: "Chave ausente, inválida ou expirada.",
      retryable: false,
    });
  }
});

it("limita o corpo JSON por rota e recusa UTF-8 inválido e JSON malformado", async () => {
  const f = await fixture();
  const post = (path: string, body: BodyInit) =>
    f.call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  const files = (size: number) =>
    JSON.stringify({ companyId: f.scope.companyId, files: [], pad: "x".repeat(size) });
  // Above the 16 KiB of any public route: not a valid request.
  expect((await post("/v1/imports", files(16_384))).body.error.code).toBe("INVALID_REQUEST");
  // Routes with a tighter limit answer 413, as before.
  const webhook = await post(
    "/v1/webhook-endpoints",
    JSON.stringify({ companyId: f.scope.companyId, pad: "x".repeat(8192) }),
  );
  expect([webhook.status, webhook.body.error.code]).toEqual([413, "FILE_TOO_LARGE"]);
  const reprocess = await post(
    `/v1/documents/${"d".repeat(32)}/reprocess?companyId=${f.scope.companyId}`,
    JSON.stringify({ pad: "x".repeat(1024) }),
  );
  expect([reprocess.status, reprocess.body.error.code]).toEqual([413, "FILE_TOO_LARGE"]);
  for (const body of [new Uint8Array([0x7b, 0xff, 0x7d]), "{", "[1,"]) {
    const result = await post("/v1/imports", body);
    expect([result.status, result.body.error.code]).toEqual([400, "INVALID_REQUEST"]);
  }
  // The contract refuses unknown fields before the domain runs.
  const extra = await post(
    "/v1/operations/x/pause",
    JSON.stringify({ expectedGeneration: 1, x: 1 }),
  );
  expect([extra.status, extra.body.error.code]).toEqual([400, "INVALID_REQUEST"]);
});

it("o domínio recebe a entrada interpretada e nomeia o que não encontrou", async () => {
  const f = await fixture();
  const pause = await f.call(`/v1/operations/${"o".repeat(32)}/pause`, {
    method: "POST",
    body: JSON.stringify({ expectedGeneration: 0 }),
  });
  expect(pause.status).toBe(404);
  expect(pause.body.error).toEqual({
    code: "NOT_FOUND",
    message: "Operação não encontrada.",
    retryable: false,
  });
  const document = await f.call(`/v1/documents/${"d".repeat(32)}?companyId=${f.scope.companyId}`);
  expect(document.body.error).toMatchObject({
    code: "NOT_FOUND",
    message: "Documento não encontrado.",
  });
});

it("valida o resultado estruturado contra o contrato antes de serializar", async () => {
  const route = parseRequest("GET", new URL("https://api.test/v1/operations/op1"), {})!;
  const operation = {
    id: "op1",
    state: "running",
    generation: 2,
    attempts: 1,
    nextAttemptAt: null,
    code: null,
    result: null,
    uncertain: false,
  };
  const ok = jsonAnswer(route, { data: operation }, "request-0");
  expect(ok).not.toBeInstanceOf(Response);
  if (ok instanceof Response) return;
  // The telemetry reference comes from the structured result, not from re-reading the body.
  expect(ok.operationId).toBe("op1");
  expect(ok.response.status).toBe(200);
  expect(await ok.response.json()).toEqual({ data: operation, requestId: "request-0" });
  // A malformed DTO or an undeclared status never reaches the wire.
  for (const result of [
    { data: { ...operation, extra: true } },
    { data: operation, status: 202 },
  ]) {
    const answer = jsonAnswer(route, result, "request-1");
    const response = answer instanceof Response ? answer : answer.response;
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "UNAVAILABLE", retryable: true },
      requestId: "request-1",
    });
  }
  // Outside the contract there is no JSON success to give.
  const unmatched = jsonAnswer(null, { data: {} }, "request-2");
  expect((unmatched instanceof Response ? unmatched : unmatched.response).status).toBe(503);
});

it("mapeia erros de domínio para o vocabulário público sem copiar texto livre", () => {
  expect(publicError(new ConvexError({ code: "IDEMPOTENCY_CONFLICT" })).status).toBe(409);
  expect(publicError(new ConvexError({ code: "NOT_FOUND" }), "Empresa não encontrada.")).toEqual({
    status: 404,
    error: { code: "NOT_FOUND", message: "Empresa não encontrada.", retryable: false },
  });
  expect(publicError(new ConvexError({ code: "QUOTA_EXCEEDED" })).error).toMatchObject({
    code: "RATE_LIMITED",
    retryable: false,
  });
  expect(publicError(new ConvexError({ code: "REFERENCE_VERSION_UNAVAILABLE" }))).toEqual({
    status: 404,
    error: {
      code: "NOT_FOUND",
      message: "Versão de referência não encontrada.",
      retryable: false,
    },
  });
  const field = publicError(
    new ConvexError({ code: "ISSUANCE_FIELD_INVALID", field: "taker.document" }),
  );
  expect(field.error.field).toBe("taker.document");
  expect(
    publicError(new ConvexError({ code: "ISSUANCE_FIELD_INVALID", field: "<script>" })).error,
  ).not.toHaveProperty("field");
  for (const error of [
    new Error("segredo interno"),
    new ConvexError({ code: "ACCESS_DENIED", message: "segredo interno" }),
  ]) {
    const result = publicError(error);
    expect(result).toMatchObject({ status: 503, error: { code: "UNAVAILABLE", retryable: true } });
    expect(JSON.stringify(result)).not.toContain("segredo");
  }
});
