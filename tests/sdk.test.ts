import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import { FreecorpsClient } from "../packages/sdk/src/index";
import { routes, exactDecimal, nfePayload, parseRequest } from "../packages/contracts/src/external";
import {
  openApi,
  compatibilityFailures,
  contractGateFailures,
  publishedBaseline,
} from "../scripts/lib/external-contract.mjs";
import { fixture } from "./helpers/nfe-corpus";
import { parseNfeModel } from "../packages/fiscal-nfe/src/index";

const requestId = "request-test";
const reserved = { data: { importId: "import", fileIds: ["file"], reused: true }, requestId };
const input = {
  path: {},
  query: {},
  body: { companyId: "company", files: [{ name: "test.xml", size: 1, sha256: "a".repeat(64) }] },
};
const client = (send: typeof fetch, options = {}) =>
  new FreecorpsClient({
    baseUrl: "https://example.invalid",
    apiKey: "synthetic",
    environment: "sandbox",
    fetch: send,
    ...options,
  });
afterEach(() => vi.useRealTimers());
it.each([2_147_483_648, Number.MAX_SAFE_INTEGER])(
  "rejects overflowing timeout %s before any request",
  (timeoutMs) => {
    const send = vi.fn();
    expect(() => client(send, { timeoutMs })).toThrow();
    expect(send).not.toHaveBeenCalled();
  },
);
it("accepts the largest runtime timer delay", () => {
  expect(() => client(vi.fn(), { timeoutMs: 2_147_483_647 })).not.toThrow();
});
it.each([429, 502, 503, 504])(
  "retries a safe read after HTTP %s without a JSON envelope",
  async (status) => {
    const response = { data: { id: "import", createdAt: 1, files: [] }, requestId };
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(status === 504 ? null : "<html>Unavailable</html>", {
          status,
          headers: { "Retry-After": "0" },
        }),
      )
      .mockResolvedValueOnce(Response.json(response));
    await expect(
      client(send).call("getImport", { path: { importId: "import" }, query: {}, body: {} }),
    ).resolves.toEqual(response);
    expect(send).toHaveBeenCalledTimes(2);
  },
);
it("preserves the idempotent request across a gateway error without JSON", async () => {
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response("Bad Gateway", { status: 502, headers: { "Retry-After": "0" } }),
    )
    .mockResolvedValueOnce(Response.json(reserved));
  await expect(
    client(send).call("reserveImport", input, { idempotencyKey: "same-intent" }),
  ).resolves.toEqual(reserved);
  expect(send.mock.calls[1]![1]!.body).toBe(send.mock.calls[0]![1]!.body);
  expect(send.mock.calls[1]![1]!.headers).toEqual(send.mock.calls[0]![1]!.headers);
});
it("does not advertise HTTP retries for secret creation or one-use uploads", async () => {
  const send = vi
    .fn<typeof fetch>()
    .mockImplementation(async () =>
      Response.json(
        { error: { code: "UNAVAILABLE", message: "Unavailable", retryable: true }, requestId },
        { status: 503 },
      ),
    );
  const sdk = client(send);
  await expect(
    sdk.call("createWebhookEndpoint", {
      path: {},
      query: {},
      body: {
        companyId: "company",
        name: "Endpoint",
        url: "https://example.invalid",
        events: ["document.received"],
      },
    }),
  ).rejects.toMatchObject({ code: "UNAVAILABLE", status: 503, requestId, retryable: false });
  await expect(
    sdk.upload(
      { url: "https://example.invalid/v1/import-upload", token: "synthetic" },
      new Uint8Array(),
    ),
  ).rejects.toMatchObject({ code: "UNAVAILABLE", status: 503, requestId, retryable: false });
  expect(send).toHaveBeenCalledTimes(2);
});
it("honors an explicit refusal to retry even on a transient HTTP status", async () => {
  const send = vi
    .fn<typeof fetch>()
    .mockImplementation(async () =>
      Response.json(
        { error: { code: "UNAVAILABLE", message: "Unavailable", retryable: false }, requestId },
        { status: 503 },
      ),
    );
  await expect(
    client(send).call("getImport", { path: { importId: "import" }, query: {}, body: {} }),
  ).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: false });
  expect(send).toHaveBeenCalledTimes(1);
});
it("keeps malformed success and permanent non-JSON errors non-retryable", async () => {
  for (const status of [200, 403]) {
    const send = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("not-json", { status }));
    await expect(
      client(send).call("getImport", { path: { importId: "import" }, query: {}, body: {} }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE", status, retryable: false });
    expect(send).toHaveBeenCalledTimes(1);
  }
});
it("accepts the alphanumeric CNPJ corpus but rejects letters in numeric key positions", () => {
  const model = parseNfeModel(fixture("invoice-alphanumeric"), "synthetic");
  const key = model.document.key;
  const parse = (value: string) =>
    routes.listDocuments.input.safeParse({
      path: {},
      query: { companyId: "company", key: value },
      body: {},
    }).success;
  expect(parse(key)).toBe(true);
  expect(parse("A" + key.slice(1))).toBe(false);
  expect(parse(key.slice(0, 43) + "B")).toBe(false);
});
it("retries an uncertain idempotent reservation with identical key and bytes", async () => {
  const calls: RequestInit[] = [];
  const send: typeof fetch = async (_url, init) => {
    calls.push(init!);
    if (calls.length === 1) throw new Error("response lost");
    return Response.json(reserved);
  };
  expect(
    await client(send).call("reserveImport", input, { idempotencyKey: "stable-intent" }),
  ).toEqual(reserved);
  expect(calls).toHaveLength(2);
  expect(calls[1]!.body).toBe(calls[0]!.body);
  expect(calls[1]!.headers).toEqual(calls[0]!.headers);
});
it("never repeats secret creation or upload after transport failure", async () => {
  const send = vi.fn<typeof fetch>().mockRejectedValue(new Error("lost"));
  await expect(
    client(send).call("createWebhookEndpoint", {
      path: {},
      query: {},
      body: {
        companyId: "company",
        name: "Endpoint",
        url: "https://example.invalid",
        events: ["document.received"],
      },
    }),
  ).rejects.toMatchObject({ code: "NETWORK_ERROR", retryable: false });
  expect(send).toHaveBeenCalledTimes(1);
  await expect(
    client(send).upload(
      { url: "https://attacker.invalid/v1/import-upload", token: "secret" },
      new Uint8Array(),
    ),
  ).rejects.toMatchObject({ code: "UPLOAD_ORIGIN_INVALID" });
  expect(send).toHaveBeenCalledTimes(1);
});
it("does not retry permanent failures or malformed success and preserves requestId", async () => {
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json(
        { error: { code: "SCOPE_DENIED", message: "Negado", retryable: false }, requestId },
        { status: 403 },
      ),
    );
  await expect(
    client(send).call("getImport", { path: { importId: "import" }, query: {}, body: {} }),
  ).rejects.toMatchObject({ status: 403, code: "SCOPE_DENIED", requestId });
  expect(send).toHaveBeenCalledTimes(1);
  send.mockResolvedValue(Response.json({ ...reserved, privateStorageId: "private" }));
  await expect(
    client(send).call("reserveImport", input, { idempotencyKey: "stable-intent" }),
  ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});
it("normalizes binary transfer failures without repeating the transfer", async () => {
  const send = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("lost"));
  const sdk = client(send);
  const ticket = { url: "https://example.invalid/v1/import-upload", token: "synthetic" };
  await expect(sdk.upload(ticket, new Uint8Array())).rejects.toMatchObject({
    code: "NETWORK_ERROR",
    retryable: false,
  });
  await expect(
    sdk.downloadOriginal({ artifactId: "artifact", companyId: "company" }),
  ).rejects.toMatchObject({ code: "NETWORK_ERROR", retryable: true });
  expect(send).toHaveBeenCalledTimes(2);
  await expect(
    client(send, { maxRetries: 0 }).call("getImport", {
      path: { importId: "import" },
      query: {},
      body: {},
    }),
  ).rejects.toMatchObject({ code: "NETWORK_ERROR", retryable: true });
  send.mockResolvedValue(new Response("not-json", { headers: { "X-Request-Id": requestId } }));
  await expect(sdk.upload(ticket, new Uint8Array())).rejects.toMatchObject({
    code: "INVALID_RESPONSE",
    requestId,
  });
  const controller = new AbortController();
  const canceled = client(async () => {
    controller.abort();
    return new Response(
      new ReadableStream({
        start(stream) {
          stream.error(new DOMException("Aborted", "AbortError"));
        },
      }),
    );
  });
  await expect(
    canceled.call(
      "getImport",
      { path: { importId: "import" }, query: {}, body: {} },
      { signal: controller.signal },
    ),
  ).rejects.toMatchObject({ code: "ABORTED" });
});
it("honors cancellation during Retry-After instead of starting another attempt", async () => {
  const controller = new AbortController();
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json(
        { error: { code: "RATE_LIMITED", message: "Aguarde", retryable: true }, requestId },
        { status: 429, headers: { "Retry-After": "120" } },
      ),
    );
  const pending = client(send).call(
    "getImport",
    { path: { importId: "import" }, query: {}, body: {} },
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 20);
  await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  expect(send).toHaveBeenCalledTimes(1);
});
it("rejects undocumented success statuses for binary transfers", async () => {
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ data: { uploaded: true }, requestId }, { status: 201 }));
  await expect(
    client(send).upload(
      { url: "https://example.invalid/v1/import-upload", token: "synthetic" },
      new Uint8Array(),
    ),
  ).rejects.toMatchObject({ code: "INVALID_RESPONSE", status: 201 });
  send.mockResolvedValue(new Response(null, { status: 204 }));
  await expect(
    client(send).downloadOriginal({ artifactId: "artifact", companyId: "company" }),
  ).rejects.toMatchObject({ code: "INVALID_RESPONSE", status: 204 });
  expect(send).toHaveBeenCalledTimes(2);
});
it("rejects binary floats, conflicting model discriminators and duplicate query parameters", () => {
  expect(exactDecimal.parse("9007199254740993.1234567890")).toBe("9007199254740993.1234567890");
  expect(exactDecimal.safeParse(24.69).success).toBe(false);
  expect(nfePayload.safeParse({ kind: "invoice", model: "65" }).success).toBe(false);
  expect(() =>
    parseRequest("GET", new URL("https://example.invalid/v1/companies?limit=1&limit=2"), {}),
  ).toThrow();
  expect(
    routes.documentItems.input.safeParse({
      path: { documentId: "document" },
      query: { companyId: "company", versionId: "version", limit: 26 },
      body: {},
    }).success,
  ).toBe(false);
});
it("detects response/request/error/optional drift against the versioned OpenAPI baseline", () => {
  const before = openApi(),
    after = structuredClone(before);
  expect(compatibilityFailures(before, after)).toEqual([]);
  const downgraded = structuredClone(before);
  downgraded.info.version = "0.9.0";
  expect(compatibilityFailures(before, downgraded)).toEqual(["root info.version: major downgrade"]);
  const upgraded = structuredClone(before);
  upgraded.info.version = `${Number(before.info.version.split(".")[0]) + 1}.0.0`;
  expect(compatibilityFailures(before, upgraded)).toEqual([]);
  delete after.paths["/v1/imports"];
  expect(compatibilityFailures(before, after)).toContain("POST /v1/imports");
  const changed = structuredClone(before);
  (
    changed.components.schemas.Error as { properties: { requestId: { type: string } } }
  ).properties.requestId.type = "number";
  expect(compatibilityFailures(before, changed)).toContain("schema Error");
  const auth = structuredClone(before);
  auth.security = [];
  expect(compatibilityFailures(before, auth)).toContain("root security");
  const optional = structuredClone(before);
  (
    optional.components.schemas.listCompaniesRequest as {
      properties: { query: { required: string[] } };
    }
  ).properties.query.required = ["cursor"];
  expect(compatibilityFailures(before, optional)).toContain("schema listCompaniesRequest");
  expect(openApi()).toEqual(before);
});
describe("contract gate against the last published contract (decision of 26/10/2026)", () => {
  const withVersion = (version: string) => {
    const document = structuredClone(openApi());
    document.info.version = version;
    return document;
  };
  const breaking = (version: string) => {
    const document = withVersion(version);
    (
      document.components.schemas.Error as { properties: { requestId: { type: string } } }
    ).properties.requestId.type = "number";
    return document;
  };
  it("accepts a change inside a major that was never published", () => {
    expect(
      contractGateFailures({
        base: withVersion("8.0.0"),
        published: null,
        next: breaking("8.0.0"),
      }),
    ).toEqual([]);
    // A major above the published one is not released yet either.
    expect(
      contractGateFailures({
        base: withVersion("8.0.0"),
        published: withVersion("7.0.0"),
        next: breaking("8.0.0"),
      }),
    ).toEqual([]);
  });
  it("refuses a change inside the published major, with or without a minor bump", () => {
    for (const version of ["8.0.0", "8.1.0"])
      expect(
        contractGateFailures({
          base: withVersion("8.0.0"),
          published: withVersion("8.0.0"),
          next: breaking(version),
        }),
      ).toContain("schema Error");
    expect(
      contractGateFailures({
        base: withVersion("8.0.0"),
        published: withVersion("8.0.0"),
        next: withVersion("8.0.0"),
      }),
    ).toEqual([]);
    expect(
      contractGateFailures({
        base: withVersion("8.0.0"),
        published: withVersion("8.0.0"),
        next: breaking("9.0.0"),
      }),
    ).toEqual([]);
  });
  it("refuses lowering the major against the base and against the published contract", () => {
    expect(
      contractGateFailures({
        base: withVersion("8.0.0"),
        published: null,
        next: withVersion("7.0.0"),
      }),
    ).toEqual(["root info.version: major downgrade"]);
    expect(
      contractGateFailures({
        base: null,
        published: withVersion("8.0.0"),
        next: withVersion("7.0.0"),
      }),
    ).toEqual(["root info.version: major downgrade from published 8.0.0"]);
  });
  it("reads the published baseline only when its commit, hash and version match the record", () => {
    const text = JSON.stringify(withVersion("8.0.0"));
    const sha = (value: string) => createHash("sha256").update(value).digest("hex");
    const record = {
      published: { version: "8.0.0", commit: "a".repeat(40), openapiSha256: sha(text) },
    };
    expect(publishedBaseline(record, () => text, sha)?.info.version).toBe("8.0.0");
    expect(() => publishedBaseline(record, () => text + " ", sha)).toThrow("SHA-256");
    expect(() =>
      publishedBaseline({ published: { ...record.published, version: "7.0.0" } }, () => text, sha),
    ).toThrow("versão");
    expect(publishedBaseline({ published: null }, () => text, sha)).toBeNull();
    const withSnapshot = {
      published: {
        ...record.published,
        snapshot: "packages/contracts/published/openapi-8.0.0.json",
      },
    };
    const readAtCommit = () => {
      throw new Error("commit fora do histórico");
    };
    expect(publishedBaseline(withSnapshot, readAtCommit, sha, () => text)?.info.version).toBe(
      "8.0.0",
    );
    expect(() => publishedBaseline(withSnapshot, readAtCommit, sha)).toThrow("snapshot");
    expect(() =>
      publishedBaseline(
        { published: { ...withSnapshot.published, snapshot: "../segredo.json" } },
        readAtCommit,
        sha,
        () => text,
      ),
    ).toThrow("snapshot inválido");
  });
  it("records the contract published with the SDK on 01/11/2026 (#83)", () => {
    const record = JSON.parse(
      readFileSync(new URL("../packages/contracts/published.json", import.meta.url), "utf8"),
    );
    expect(record.published).toEqual({
      version: "8.0.0",
      commit: "08e85d807a8687d655066289bac689215f49ebc8",
      openapiSha256: "edfcb60eb1adaa170d3c7f1232153162d51bd94ad4924132a8e1e79b3e548c1a",
      publishedAt: "2026-11-01T20:17:03.175Z",
      snapshot: "packages/contracts/published/openapi-8.0.0.json",
    });
    expect(record.note).toMatch(/@freecorps\/sdk@0\.1\.0/);
    // The commit lives in the archived repository: the versioned copy keeps the same bytes.
    const copy = readFileSync(new URL(`../${record.published.snapshot}`, import.meta.url));
    expect(createHash("sha256").update(copy).digest("hex")).toBe(record.published.openapiSha256);
  });
});
it("keeps XML filename validation identical in Zod and the generated JSON Schema", () => {
  const schema = openApi().components.schemas.reserveImportRequest as {
    properties: {
      body: { properties: { files: { items: { properties: { name: { pattern: string } } } } } };
    };
  };
  const pattern = new RegExp(schema.properties.body.properties.files.items.properties.name.pattern);
  for (const [name, valid] of [
    ["nota.XML", true],
    ["nota.xml", true],
    ["../nota.xml", false],
    ["nota\n.xml", false],
    ["nota.json", false],
  ] as const) {
    const value = structuredClone(input);
    value.body.files[0]!.name = name;
    expect(routes.reserveImport.input.safeParse(value).success).toBe(valid);
    expect(pattern.test(name)).toBe(valid);
  }
});

const issuanceView = {
  id: "issuance",
  companyId: "company",
  projectId: "project",
  environment: "sandbox",
  operationId: "operation",
  operationState: "queued",
  state: "processing",
  transport: "simulated",
  target: "sefin-nacional",
  series: "1",
  number: 1,
  dpsId: "DPS355030821122233300018100001000000000000001",
  issueDate: "2026-10-08",
  competence: "2026-10",
  market: "domestic",
  amount: { currency: "BRL", value: "1000.00" },
  serviceBrl: "1000.00",
  exchange: null,
  accessKey: null,
  nfseNumber: null,
  code: null,
  rejections: [],
  artifacts: [],
  cancellation: null,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
};
const issuanceInput = {
  path: {},
  query: {},
  body: {
    companyId: "company",
    activityCode: "licenca",
    competence: "2026-10",
    issuerEmail: "fiscal@prestador.example",
    market: "domestic" as const,
    taker: {
      kind: "national" as const,
      document: "11444777000161",
      name: "Tomador Sintético Ltda",
      address: {
        municipalityCode: "3550308",
        postalCode: "01001000",
        street: "Praça da Sé",
        number: "100",
        district: "Sé",
      },
    },
    description: "Licença de uso de software",
    amount: { currency: "BRL", value: "1000" },
    issRate: "2.5",
    issWithheld: false,
  },
};
it("issues with a required idempotency key, retries the same bytes and expects 202", async () => {
  const accepted = { data: { reused: false, issuance: issuanceView }, requestId };
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response("Bad Gateway", { status: 502, headers: { "Retry-After": "0" } }),
    )
    .mockResolvedValueOnce(Response.json(accepted, { status: 202 }));
  const sdk = client(send);
  await expect(sdk.call("createIssuance", issuanceInput)).rejects.toMatchObject({
    code: "IDEMPOTENCY_KEY_REQUIRED",
  });
  expect(send).not.toHaveBeenCalled();
  await expect(
    sdk.call("createIssuance", issuanceInput, { idempotencyKey: "nota-1" }),
  ).resolves.toEqual(accepted);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1]![1]!.body).toBe(send.mock.calls[0]![1]!.body);
  expect((send.mock.calls[0]![0] as URL).href).toBe("https://example.invalid/v1/issuances");
  // Money is decimal text: a number never reaches the wire.
  const float = structuredClone(issuanceInput);
  (float.body.amount as { value: unknown }).value = 1000;
  await expect(
    sdk.call("createIssuance", float, { idempotencyKey: "nota-2" }),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  // A 200 is not the documented acceptance.
  send.mockResolvedValueOnce(Response.json(accepted));
  await expect(
    sdk.call("createIssuance", issuanceInput, { idempotencyKey: "nota-3" }),
  ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});
it("exposes the rejected field of an issuance error and does not retry it", async () => {
  const send = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json(
      {
        error: {
          code: "ISSUANCE_TAKER_DOCUMENT_INVALID",
          message: "CPF ou CNPJ do tomador inválido.",
          retryable: false,
          field: "taker.document",
        },
        requestId,
      },
      { status: 400 },
    ),
  );
  await expect(
    client(send).call("createIssuance", issuanceInput, { idempotencyKey: "nota" }),
  ).rejects.toMatchObject({
    status: 400,
    code: "ISSUANCE_TAKER_DOCUMENT_INVALID",
    field: "taker.document",
    requestId,
  });
  expect(send).toHaveBeenCalledTimes(1);
});
const connection = {
  id: "stream",
  organizationId: "organization",
  companyId: "company",
  projectId: "project",
  environment: "production",
  state: "attention",
  version: 3,
  checkpoint: "000000000000001",
  sourceCursor: null,
  sourceMaxNsu: null,
  nextAllowedAt: 1_800_000_000_000,
  lastAttemptAt: null,
  lastSuccessAt: null,
  code: "SOURCE_CONSUMPTION_BLOCKED",
  received: 0,
  operationId: null,
  operationState: null,
  certificateState: "active",
  certificateExpiresAt: null,
};
it("reads sourceMaxNsu, null before the first answer, and requires the field (#494)", async () => {
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ data: connection, requestId }))
    .mockResolvedValueOnce(
      Response.json({ data: { ...connection, sourceMaxNsu: "000000000000009" }, requestId }),
    )
    .mockResolvedValueOnce(
      Response.json({ data: { ...connection, sourceMaxNsu: undefined }, requestId }),
    );
  const read = () =>
    client(send).call("getCapture", { path: {}, query: { companyId: "company" }, body: {} });
  expect((await read()).data).toMatchObject({ sourceMaxNsu: null });
  expect((await read()).data).toMatchObject({ sourceMaxNsu: "000000000000009" });
  await expect(read()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});
it("exposes SOURCE_COOLDOWN with nextAllowedAt and does not resume in a loop (#494)", async () => {
  const send = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json(
      {
        error: {
          code: "SOURCE_COOLDOWN",
          message: "A Receita só aceita a próxima consulta depois de um intervalo.",
          retryable: true,
          nextAllowedAt: 1_800_000_000_000,
        },
        requestId,
      },
      { status: 409 },
    ),
  );
  await expect(
    client(send).call("controlCapture", {
      path: {},
      query: {},
      body: { companyId: "company", action: "resume", expectedVersion: 3 },
    }),
  ).rejects.toMatchObject({
    status: 409,
    code: "SOURCE_COOLDOWN",
    nextAllowedAt: 1_800_000_000_000,
    requestId,
    // The API says retryable, but the SDK only retries 429/502/503/504: waiting is the caller's.
    retryable: false,
  });
  expect(send).toHaveBeenCalledTimes(1);
});
it("reads, lists, cancels and downloads issuance XML through the typed client", async () => {
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ data: issuanceView, requestId }))
    .mockResolvedValueOnce(
      Response.json({ data: { page: [issuanceView], nextCursor: null }, requestId }),
    )
    .mockResolvedValueOnce(
      Response.json({ data: { reused: true, issuance: issuanceView }, requestId }, { status: 202 }),
    )
    .mockResolvedValueOnce(new Response("<NFSe/>"));
  const sdk = client(send);
  await sdk.call("getIssuance", {
    path: { issuanceId: "issuance" },
    query: { companyId: "company" },
    body: {},
  });
  await sdk.call("listIssuances", {
    path: {},
    query: { companyId: "company", state: "authorized", limit: 10 },
    body: {},
  });
  await sdk.call(
    "cancelIssuance",
    {
      path: { issuanceId: "issuance" },
      query: {},
      body: { companyId: "company", reasonCode: "2", reason: "Serviço não prestado ao tomador" },
    },
    { idempotencyKey: "cancela-1" },
  );
  const xml = await sdk.downloadIssuanceArtifact({
    issuanceId: "issuance",
    artifactId: "artifact",
    companyId: "company",
  });
  expect(new TextDecoder().decode(xml)).toBe("<NFSe/>");
  expect(
    send.mock.calls.map(([url, init]) => `${init!.method ?? "GET"} ${(url as URL).href}`),
  ).toEqual([
    "GET https://example.invalid/v1/issuances/issuance?companyId=company",
    "GET https://example.invalid/v1/issuances?companyId=company&limit=10&state=authorized",
    "POST https://example.invalid/v1/issuances/issuance/cancellation",
    "GET https://example.invalid/v1/issuances/issuance/artifacts/artifact?companyId=company",
  ]);
  await expect(
    sdk.downloadIssuanceArtifact({ issuanceId: "", artifactId: "a", companyId: "c" }),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
});
