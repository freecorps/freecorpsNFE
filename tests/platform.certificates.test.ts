/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { randomBytes } from "node:crypto";
import schema from "../platform/convex/schema";
import { api, internal, components } from "../platform/convex/_generated/api";
import { register } from "../platform/test-setup";
import { syntheticCertificate } from "./helpers/certificates";
import { consoleProjectFor } from "./helpers/console";
import { certificateUsable } from "../platform/convex/lib/certificateAccess";
import { executionAllowed } from "../platform/convex/lib/operationCore";
import { validatePendingCertificate } from "../platform/convex/certificateWorker";
const modules = import.meta.glob("../platform/convex/**/*.ts");
const ring = {
  active: "v1",
  keys: { v1: randomBytes(32).toString("hex"), v2: randomBytes(32).toString("hex") },
};
beforeEach(() => {
  vi.useFakeTimers();
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5197",
    CONVEX_SITE_URL: "http://127.0.0.1:3253",
    BETTER_AUTH_SECRET: "synthetic-certificate-test",
    FNFE_PLATFORM_CERT_KEYS: JSON.stringify(ring),
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
function setup() {
  const t = convexTest(schema, modules);
  register(t);
  return t;
}
async function actor(t: ReturnType<typeof setup>) {
  const now = Date.now();
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Teste certificado",
        email: `${crypto.randomUUID()}@development.invalid`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const session = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        userId: user._id,
        expiresAt: now + 3600_000,
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  return {
    user,
    client: t.withIdentity({
      subject: user._id,
      sessionId: session._id,
      issuer: "http://127.0.0.1:3253",
    }),
  };
}
async function fixture(options?: Parameters<typeof syntheticCertificate>[0]) {
  const t = setup(),
    owner = await actor(t);
  const org = await owner.client.mutation(api.organizations.create, {
    name: "Certificados de teste",
    slug: `cert-${crypto.randomUUID()}`,
  });
  const company = await owner.client.mutation(api.companies.create, {
    organizationId: org.organizationId,
    cnpj: "00000000000191",
    name: "Empresa sintética",
    address: {
      street: "Rua teste",
      number: "1",
      complement: "",
      district: "Centro",
      city: "São Paulo",
      state: "SP",
      postalCode: "01000000",
    },
  });
  const scope = { organizationId: org.organizationId, companyId: company.companyId };
  const material = syntheticCertificate(options);
  const upload = async (password = material.password.toString()) =>
    owner.client.action(api.certificateWorker.upload, {
      ...scope,
      pfx: Uint8Array.from(material.pfx).buffer,
      password,
    });
  const list = () =>
    owner.client.query(api.certificates.list, {
      ...scope,
      contextKey: "proof",
      paginationOpts: { numItems: 20, cursor: null },
    });
  return { t, owner, scope, material, upload, list };
}
it("does not reject a valid PFX when persisting validation fails", async () => {
  const f = await fixture();
  const id = await f.upload();
  const cert = await f.t.run((ctx) => ctx.db.get("certificates", id));
  const runMutation = vi.fn().mockRejectedValue(new Error("commit unavailable"));
  await expect(
    validatePendingCertificate(
      {
        runQuery: vi.fn().mockResolvedValueOnce(cert).mockResolvedValueOnce("00000000000191"),
        runMutation,
      },
      { id },
    ),
  ).rejects.toThrow("commit unavailable");
  expect(runMutation).toHaveBeenCalledTimes(1);
  expect(runMutation.mock.calls[0][1]).toMatchObject({ id, metadata: { cnpj: "00000000000191" } });
  expect((await f.t.run((ctx) => ctx.db.get("certificates", id)))?.state).toBe("validating");
});
it("reports missing server key without persisting upload secrets", async () => {
  const f = await fixture();
  vi.stubEnv("FNFE_PLATFORM_CERT_KEYS", "");
  await expect(f.upload()).rejects.toThrow("CERTIFICATE_KEY_UNAVAILABLE");
  const certs = await f.t.run((ctx) => ctx.db.query("certificates").collect());
  expect(certs).toHaveLength(1);
  expect(certs[0]).toMatchObject({ state: "rejected", code: "CERTIFICATE_KEY_UNAVAILABLE" });
  expect(certs[0].envelope).toBeUndefined();
});
it("uploads encrypted material, validates asynchronously and exposes metadata only", async () => {
  const f = await fixture(),
    id = await f.upload();
  expect((await f.list()).page[0]?.state).toBe("validating");
  const encrypted = await f.t.query(internal.certificates.encrypted, { id });
  expect(encrypted?.envelope).toBeDefined();
  expect(Buffer.from(encrypted!.envelope!.pfx).includes(f.material.pfx)).toBe(false);
  await f.t.action(internal.certificateWorker.validate, { id });
  const page = (await f.list()).page;
  expect(page[0]).toMatchObject({
    state: "active",
    version: 1,
    metadata: { cnpj: "00000000000191" },
  });
  expect(JSON.stringify(page)).not.toMatch(/password|envelope|wrappedKey|pfx|privateKey/i);
  const scheduled = await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  expect(JSON.stringify(scheduled)).not.toContain(f.material.password.toString());
  expect(JSON.stringify(scheduled)).not.toContain(f.material.pfx.toString("base64"));
});
it("rejects wrong password and retains the previous active certificate", async () => {
  const f = await fixture(),
    first = await f.upload();
  await f.t.action(internal.certificateWorker.validate, { id: first });
  const second = await f.upload("wrong");
  await f.t.action(internal.certificateWorker.validate, { id: second });
  expect((await f.list()).page.map((c) => c.state)).toEqual(["rejected", "active"]);
  expect(
    (await f.t.query(internal.certificates.encrypted, { id: second }))?.envelope,
  ).toBeUndefined();
});
it("isolates organizations and refuses viewer, removed member and anonymous writes", async () => {
  const f = await fixture(),
    stranger = await actor(f.t),
    id = await f.upload();
  const args = { ...f.scope, contextKey: "forged", paginationOpts: { numItems: 10, cursor: null } };
  await expect(stranger.client.query(api.certificates.list, args)).rejects.toThrow();
  await expect(f.t.query(api.certificates.list, args)).rejects.toThrow();
  await expect(
    stranger.client.mutation(api.certificates.revoke, { ...f.scope, id }),
  ).rejects.toThrow();
  const member = await f.t.run((ctx) =>
    ctx.db.insert("memberships", {
      organizationId: f.scope.organizationId,
      authUserId: stranger.user._id,
      name: "Viewer",
      email: stranger.user.email,
      role: "viewer",
      state: "active",
      version: 1,
      joinedAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await expect(
    stranger.client.action(api.certificateWorker.upload, {
      ...f.scope,
      pfx: Uint8Array.from(f.material.pfx).buffer,
      password: "nope",
    }),
  ).rejects.toThrow();
  await f.t.run((ctx) => ctx.db.patch("memberships", member, { role: "admin", state: "removed" }));
  await expect(stranger.client.query(api.certificates.list, args)).rejects.toThrow();
});
it("revoked upload permission cannot activate an already queued validation", async () => {
  const f = await fixture(),
    id = await f.upload();
  const cert = (await f.t.query(internal.certificates.encrypted, { id }))!;
  await f.t.run((ctx) =>
    ctx.db.patch("memberships", cert.membershipId, { state: "removed", version: 2 }),
  );
  await f.t.action(internal.certificateWorker.validate, { id });
  expect(await f.t.query(internal.certificates.encrypted, { id })).toMatchObject({
    state: "rejected",
    code: "ACCESS_REVOKED",
  });
});
it("out-of-order validation cannot replace a newer certificate", async () => {
  const f = await fixture(),
    first = await f.upload(),
    second = await f.upload();
  await f.t.action(internal.certificateWorker.validate, { id: second });
  await f.t.action(internal.certificateWorker.validate, { id: first });
  expect((await f.list()).page.map((c) => c.state)).toEqual(["active", "rejected"]);
});
it("rotation, revocation and expiration invalidate pinned work independently of the expiry job", async () => {
  const f = await fixture(),
    first = await f.upload();
  await f.t.action(internal.certificateWorker.validate, { id: first });
  const usable = (id: typeof first, version: number) =>
    f.t.run((ctx) => certificateUsable(ctx, f.scope, { id, version }, Date.now()));
  expect(await usable(first, 1)).toBe(true);
  const second = await f.upload();
  await f.t.action(internal.certificateWorker.validate, { id: second });
  expect(await usable(first, 1)).toBe(false);
  expect(await usable(second, 2)).toBe(true);
  const cert = (await f.t.query(internal.certificates.encrypted, { id: second }))!;
  vi.setSystemTime(cert.metadata!.notAfter);
  expect(await usable(second, 2)).toBe(false);
  vi.setSystemTime(cert.createdAt + 1000);
  await f.owner.client.mutation(api.certificates.revoke, { ...f.scope, id: second });
  expect(await usable(second, 2)).toBe(false);
  expect(
    (await f.t.query(internal.certificates.encrypted, { id: second }))?.envelope,
  ).toBeUndefined();
});
it("keeps expired history when a new certificate is activated", async () => {
  const f = await fixture({ now: Date.now() - 86400_000 + 60_000 });
  const first = await f.upload();
  await f.t.action(internal.certificateWorker.validate, { id: first });
  vi.setSystemTime(Date.now() + 60_001);
  await f.t.mutation(internal.certificates.expire, { id: first });
  expect(
    (await f.t.run((ctx) => ctx.db.query("certificateHeads").first()))?.activeId,
  ).toBeUndefined();
  const fresh = syntheticCertificate();
  const second = await f.owner.client.action(api.certificateWorker.upload, {
    ...f.scope,
    pfx: Uint8Array.from(fresh.pfx).buffer,
    password: fresh.password.toString(),
  });
  await f.t.action(internal.certificateWorker.validate, { id: second });
  expect((await f.list()).page.map((cert) => cert.state)).toEqual(["active", "expired"]);
  expect((await f.t.run((ctx) => ctx.db.query("certificateHeads").first()))?.activeId).toBe(second);
});
it("rewrap preserves certificate identity and records the new master key version", async () => {
  const f = await fixture(),
    id = await f.upload();
  await f.t.action(internal.certificateWorker.validate, { id });
  const previous = (await f.t.query(internal.certificates.encrypted, { id }))!;
  vi.stubEnv("FNFE_PLATFORM_CERT_KEYS", JSON.stringify({ ...ring, active: "v2" }));
  await f.owner.client.action(api.certificateWorker.rewrap, { ...f.scope, id });
  const next = (await f.t.query(internal.certificates.encrypted, { id }))!;
  expect(next.envelope?.keyVersion).toBe("v2");
  expect(next.version).toBe(previous.version);
  expect(next.envelope?.pfx).toEqual(previous.envelope?.pfx);
  const events = await f.t.run((ctx) =>
    ctx.db
      .query("certificateAudit")
      .withIndex("by_companyId", (q) => q.eq("companyId", f.scope.companyId))
      .collect(),
  );
  expect(events.at(-1)).toMatchObject({
    action: "key_rotation",
    keyVersion: "v2",
    actor: f.owner.user._id,
  });
  expect(JSON.stringify(events)).not.toContain(f.material.password.toString());
});
it("an operation with an old pin is denied even when its access grants still exist", async () => {
  const f = await fixture(),
    id = await f.upload();
  await f.t.action(internal.certificateWorker.validate, { id });
  // A person reserves in the organization's console project, with no project grant.
  const projectId = await consoleProjectFor(f.t, f.scope.organizationId);
  const { operationId } = await f.owner.client.mutation(internal.operations.reserve, {
    ...f.scope,
    projectId,
    environment: "sandbox",
    key: crypto.randomUUID(),
    request: "{}",
    certificate: { id, version: 1 },
    task: {
      name: "cert.proof",
      scope: "documents:read",
      workload: "capture",
      executor: "testing/operationProof:execute",
    },
  });
  const allowed = () =>
    f.t.run(async (ctx) => executionAllowed(ctx, (await ctx.db.get("operations", operationId))!));
  expect(await allowed()).toBe(true);
  const running = (await f.t.mutation(internal.operations.claim, { operationId, generation: 1 }))!;
  const claim = { operationId, generation: running.generation, fence: running.fence };
  expect(await f.t.mutation(internal.certificateUse.authorize, claim)).toMatchObject({ _id: id });
  expect(await f.t.mutation(internal.operations.beginEffect, claim)).toBe(true);
  await f.owner.client.mutation(api.certificates.revoke, { ...f.scope, id });
  expect(await allowed()).toBe(false);
  expect(
    await f.t.mutation(internal.certificateUse.complete, { ...claim, result: "success" }),
  ).toBe(false);
  expect(
    await f.t.mutation(internal.operations.recordOutcome, {
      ...claim,
      outcome: { kind: "success", response: "late" },
    }),
  ).toBe(false);
  const paused = (await f.t.query(internal.certificates.encrypted, { id }))!;
  expect(paused.state).toBe("revoked");
  // Simulate revocation specifically after a checkpoint committed, before publishing it.
  await f.t.run((ctx) =>
    ctx.db.patch("operations", operationId, {
      state: "running",
      stage: "checkpoint",
      generation: 1,
      fence: 1,
      leaseUntil: Date.now() + 60_000,
    }),
  );
  expect(await f.t.mutation(internal.operations.publish, claim)).toBe(false);
  expect(
    await f.t.run((ctx) =>
      ctx.db
        .query("operationReceipts")
        .withIndex("by_operationId_and_kind", (q) => q.eq("operationId", operationId))
        .collect(),
    ),
  ).toHaveLength(0);
  await f.t.run((ctx) => ctx.db.patch("operations", operationId, { state: "paused" }));
  await expect(
    f.owner.client.mutation(api.operations.control, {
      action: "retry",
      expectedGeneration: 2,
      operationId,
    }),
  ).rejects.toThrow("ACCESS_REVOKED");
});
