import { expect, it, vi } from "vite-plus/test";
import { smokePlatform } from "./lib/platform-smoke.mjs";
import { publishRevision } from "./lib/validation-deploy.mjs";
import { bootstrapRevision } from "./lib/platform-release.mjs";
import { smokeFailure, smokeFailureDetails } from "./lib/smoke-diagnostic.mjs";

const sha = "a".repeat(40);
const previous = "b".repeat(40);
const target = {
  cloud: "https://backend.example.com",
  site: "https://api.example.com",
  frontend: "https://console.example.com",
};
const policy =
  "connect-src 'self' https://backend.example.com wss://backend.example.com https://api.example.com;";
function fixture(frontendRevisions = [sha]) {
  const request = vi.fn<typeof fetch>(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/health"))
      return Response.json({
        status: "ok",
        sha,
        appEnv: "installation",
        productEnv: "sandbox",
        fiscalEnv: "disabled",
        issuanceEnv: "disabled",
      });
    if (url.endsWith("/build.json"))
      return Response.json({ sha: frontendRevisions.shift() ?? sha, environment: "installation" });
    return new Response('<div id="root"></div>', {
      headers: { "content-type": "text/html", "content-security-policy": policy },
    });
  });
  const query = vi.fn(async () => []);
  const pause = vi.fn(async () => {});
  return { request, query, pause };
}
async function publish(f: ReturnType<typeof fixture>, bootstrap = false, to: object = target) {
  const receipts: Record<string, unknown>[] = [];
  const noop = async () => {};
  try {
    await (bootstrap ? bootstrapRevision : publishRevision)(
      sha,
      {
        preflight: noop,
        build: noop,
        eligible: async () => true,
        initializeProbe: noop,
        probe: async () => ({ key: "persistence-v1", nonce: "synthetic" }),
        backend: noop,
        frontend: noop,
        smoke: () => smokePlatform(sha, to, f.query, f),
      },
      (r: Record<string, unknown>) => receipts.push(r),
    );
  } catch {
    /* inspect the public receipt */
  }
  return receipts.at(-1);
}

it("aguarda a propagação do SHA sem republicar nem perder a sonda", async () => {
  const f = fixture([previous, sha]);
  expect(await publish(f)).toMatchObject({ state: "validated", phase: "complete" });
  expect(f.pause).toHaveBeenCalledTimes(1);
});

it("aceita o backend que informa issuanceEnv disabled", async () => {
  const f = fixture();
  f.request.mockResolvedValueOnce(
    Response.json({
      status: "ok",
      sha,
      appEnv: "installation",
      productEnv: "sandbox",
      fiscalEnv: "disabled",
      issuanceEnv: "disabled",
    }),
  );
  expect(await publish(f)).toMatchObject({ state: "validated", phase: "complete" });
});

it("preserva a causa de uma divergência permanente no recibo, sem UNKNOWN", async () => {
  const f = fixture(Array(6).fill(previous));
  expect(await publish(f)).toMatchObject({
    state: "partial",
    phase: "smoke",
    diagnostic: {
      phase: "revision",
      service: "frontend",
      code: "SHA_MISMATCH",
      expectedSha: sha,
      observedSha: previous,
    },
  });
  expect(f.pause).toHaveBeenCalledTimes(5);
  expect(f.query).not.toHaveBeenCalled();
});

it.each([false, true])(
  "registra falha HTTP sanitizada no release/bootstrap=%s",
  async (bootstrap) => {
    const f = fixture();
    f.request.mockResolvedValueOnce(
      new Response("remote-secret", { status: 503, headers: { "cf-ray": "abcdef1234567890-GRU" } }),
    );
    const receipt = await publish(f, bootstrap);
    expect(receipt).toMatchObject({
      state: "partial",
      phase: "smoke",
      diagnostic: {
        phase: "revision",
        service: "backend",
        code: "UNAVAILABLE",
        httpStatus: 503,
        requestId: "abcdef1234567890-GRU",
      },
    });
    expect(JSON.stringify(receipt)).not.toContain("remote-secret");
    expect(f.pause).not.toHaveBeenCalled();
  },
);

it.each([
  [new Response("private invalid JSON"), "INVALID_RESPONSE"],
  [Response.json([]), "INVALID_RESPONSE"],
  [Response.json({ sha: "invalid" }), "INVALID_RESPONSE"],
  [new Response("private", { status: 401 }), "AUTH_FAILED"],
  [new Response("private", { status: 404 }), "HTTP_ERROR"],
  [
    Response.json({
      sha,
      status: "ok",
      appEnv: "installation",
      productEnv: "production",
      fiscalEnv: "disabled",
    }),
    "ENVIRONMENT_MISMATCH",
  ],
  [
    Response.json({
      sha: previous,
      status: "ok",
      appEnv: "installation",
      productEnv: "sandbox",
      fiscalEnv: "production",
    }),
    "ENVIRONMENT_MISMATCH",
  ],
  [
    Response.json({
      sha,
      status: "ok",
      appEnv: "installation",
      productEnv: "sandbox",
      fiscalEnv: "disabled",
      issuanceEnv: "production",
    }),
    "ENVIRONMENT_MISMATCH",
  ],
  // Strict since #198, PR 6: the hosted sandbox has reported the field since #337.
  [
    Response.json({
      sha,
      status: "ok",
      appEnv: "installation",
      productEnv: "sandbox",
      fiscalEnv: "disabled",
    }),
    "ENVIRONMENT_MISMATCH",
  ],
] as const)("recusa respostas inválidas sem repetir o smoke (%s)", async (response, code) => {
  const f = fixture();
  f.request.mockResolvedValueOnce(response);
  expect(await publish(f)).toMatchObject({
    state: "partial",
    diagnostic: { code, service: "backend" },
  });
  expect(f.pause).not.toHaveBeenCalled();
});

it.each([
  ["TimeoutError", "TIMEOUT"],
  ["AbortError", "TIMEOUT"],
  ["TypeError", "UNAVAILABLE"],
])("classifica falha de transporte %s", async (name, code) => {
  const f = fixture();
  f.request.mockRejectedValueOnce(Object.assign(new Error("private token"), { name }));
  const receipt = await publish(f);
  expect(receipt).toMatchObject({ diagnostic: { phase: "revision", service: "backend", code } });
  expect(JSON.stringify(receipt)).not.toContain("private");
  expect(f.pause).not.toHaveBeenCalled();
});

it("identifica a API pública no recibo quando só ela falha", async () => {
  const f = fixture();
  const request = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (input, init) => {
    if (
      (input instanceof Request ? input.url : String(input)) === "https://rest.example.com/health"
    )
      throw Object.assign(new Error("private"), { name: "TypeError" });
    return request(input, init);
  });
  const receipt = await publish(f, false, { ...target, api: "https://rest.example.com" });
  expect(receipt).toMatchObject({
    diagnostic: { phase: "revision", service: "api", code: "UNAVAILABLE" },
  });
});

it.each([
  { issuanceEnv: "production" },
  { issuanceEnv: "" },
  { issuanceEnv: undefined },
  { productEnv: "production" },
  { fiscalEnv: "production" },
])("recusa a API pública que não serve o mesmo sandbox (%o)", async (change) => {
  const f = fixture();
  const request = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (input, init) => {
    if (
      (input instanceof Request ? input.url : String(input)) === "https://rest.example.com/health"
    )
      return Response.json({
        status: "ok",
        sha,
        appEnv: "installation",
        productEnv: "sandbox",
        fiscalEnv: "disabled",
        ...change,
      });
    return request(input, init);
  });
  const receipt = await publish(f, false, { ...target, api: "https://rest.example.com" });
  expect(receipt).toMatchObject({
    state: "partial",
    diagnostic: { phase: "revision", service: "api", code: "ENVIRONMENT_MISMATCH" },
  });
  expect(f.pause).not.toHaveBeenCalled();
});

it("aceita a API pública com issuanceEnv disabled", async () => {
  const to = { ...target, api: "https://rest.example.com" };
  // The console's CSP has to name the API address too, so the whole smoke can pass.
  const csp = policy.replace(";", " https://rest.example.com;");
  for (const extra of [{ issuanceEnv: "disabled" }]) {
    const f = fixture();
    const request = f.request.getMockImplementation()!;
    const api = vi.fn();
    f.request.mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://rest.example.com/health") {
        api();
        return Response.json({
          status: "ok",
          sha,
          appEnv: "installation",
          productEnv: "sandbox",
          fiscalEnv: "disabled",
          ...extra,
        });
      }
      if (!url.endsWith("/health") && !url.endsWith("/build.json"))
        return new Response('<div id="root"></div>', {
          headers: { "content-type": "text/html", "content-security-policy": csp },
        });
      return request(input, init);
    });
    expect(await publish(f, false, to)).toMatchObject({ state: "validated" });
    expect(api).toHaveBeenCalled();
  }
});

it("recusa rótulo de diagnóstico fora do vocabulário em vez de registrá-lo como unknown", () => {
  expect(() => smokeFailure({ phase: "revision", service: "novo", code: "UNAVAILABLE" })).toThrow(
    'Unlisted smoke service: "novo"',
  );
  expect(() => smokeFailure({ phase: "deploy", service: "api", code: "UNAVAILABLE" })).toThrow(
    'Unlisted smoke phase: "deploy"',
  );
  expect(() => smokeFailure({ phase: "revision", service: "api", code: "GONE" })).toThrow(
    'Unlisted smoke code: "GONE"',
  );
});

it("confere HTML e CSP de cada entrada da SPA", async () => {
  for (const path of ["", "/login", "/console"]) {
    for (const badHtml of [false, true]) {
      const f = fixture();
      const normal = f.request.getMockImplementation()!;
      f.request.mockImplementation(async (url) =>
        (url instanceof Request ? url.url : String(url)) === target.frontend + path
          ? new Response(badHtml ? "not HTML" : '<div id="root"></div>', {
              headers: { "content-type": "text/html", "content-security-policy": "connect-src *;" },
            })
          : normal(url),
      );
      expect(await publish(f)).toMatchObject({
        state: "partial",
        diagnostic: { service: "frontend", code: badHtml ? "INVALID_RESPONSE" : "POLICY_MISMATCH" },
      });
      expect(f.query).not.toHaveBeenCalled();
    }
  }
});

it("distingue indisponibilidade, resposta inválida e crons ativos", async () => {
  for (const [value, code] of [
    [null, "INVALID_RESPONSE"],
    [[{ name: "unexpected" }], "ENVIRONMENT_MISMATCH"],
  ] as const) {
    const f = fixture();
    const query = async () => value;
    try {
      await smokePlatform(sha, target, query, f);
      throw new Error("expected failure");
    } catch (error) {
      expect(smokeFailureDetails(error)).toMatchObject({
        diagnostic: { phase: "crons", service: "backend", code },
      });
    }
  }
  const f = fixture();
  f.query.mockRejectedValueOnce(new Error("secret credential"));
  const receipt = await publish(f);
  expect(receipt).toMatchObject({
    diagnostic: { phase: "crons", service: "backend", code: "QUERY_FAILED" },
  });
  expect(JSON.stringify(receipt)).not.toContain("secret");
});

it("não confunde persistência posterior com falha do smoke no bootstrap", async () => {
  const f = fixture();
  const receipts: Record<string, unknown>[] = [];
  const noop = async () => {};
  const probe = vi
    .fn()
    .mockResolvedValueOnce({ key: "persistence-v1", nonce: "synthetic" })
    .mockRejectedValueOnce(new Error("private"));
  await expect(
    bootstrapRevision(
      sha,
      {
        preflight: noop,
        build: noop,
        eligible: async () => true,
        backend: noop,
        initializeProbe: noop,
        frontend: noop,
        probe,
        smoke: () => smokePlatform(sha, target, f.query, f),
      },
      (r: Record<string, unknown>) => receipts.push(r),
    ),
  ).rejects.toThrow("persistence");
  expect(receipts.at(-1)).toMatchObject({ state: "partial", phase: "persistence" });
  expect(receipts.at(-1)).not.toHaveProperty("diagnostic");
});
