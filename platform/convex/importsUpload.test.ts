/// <reference types="vite/client" />
import { demonstrationCompany } from "../../packages/contracts/src/companies";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { it, expect, vi } from "vite-plus/test";
import { internal, api } from "./_generated/api";
import { companyGrant, person, usePlatformEnvironment } from "../../tests/helpers/platform";
import { IMPORT_MIME } from "./lib/importValues";
import type { Id } from "./_generated/dataModel";
import { requestCleanup } from "./lib/importCore";
import { fixture } from "../../tests/helpers/imports";

/** Uploads from the console: human sessions, tickets, cancellation, cleanup and tokens. */
usePlatformEnvironment({
  siteUrl: "http://localhost:5190",
  convexSiteUrl: "http://127.0.0.1:3239",
  secret: "synthetic-import-secret",
});

it("limpeza remove órfão de upload interrompido e preserva o blob vinculado", async () => {
  const f = await fixture(),
    batch = await f.reserve();
  await f.upload(batch);
  const orphan = await f.t.run((ctx) =>
    ctx.storage.store(new Blob(["orphan"], { type: IMPORT_MIME })),
  );
  // convex-test 0.0.56 omits Blob.type from system metadata; native storage preserves it.
  await f.t.run((ctx) => ctx.db.patch(orphan as never, { contentType: IMPORT_MIME } as never));
  vi.setSystemTime(Date.now() + 1000);
  await f.t.mutation(internal.importUpload.sweep, { cursor: null, before: Date.now() });
  expect(await f.t.run(async (ctx) => !!(await ctx.db.system.get("_storage", orphan)))).toBe(false);
  const file = (await f.t.run((ctx) => ctx.db.get("importFiles", batch.fileIds[0]!)))!;
  expect(
    await f.t.run(async (ctx) => !!(await ctx.db.system.get("_storage", file.storageId!))),
  ).toBe(true);
});
it("sessão humana reserva sem API key e perda do acesso pausa o worker", async () => {
  const f = await fixture(),
    owner = await person(f.t, f.scope.organizationId, "owner");
  const batch = await owner.mutation(api.imports.reserve, {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox",
    key: "human",
    files: [
      {
        name: "nota.xml",
        size: f.bytes.length,
        sha256: createHash("sha256").update(f.bytes).digest("hex"),
      },
    ],
  });
  const ticket = await owner.mutation(api.imports.upload, { fileId: batch.fileIds[0]! });
  expect(
    (
      await f.t.fetch("/v1/import-upload", {
        method: "POST",
        headers: { "X-Upload-Token": ticket.token },
        body: new Uint8Array(f.bytes),
      })
    ).status,
  ).toBe(200);
  const accepted = await owner.mutation(api.imports.confirm, { fileId: batch.fileIds[0]! });
  const op = (await f.t.run((ctx) => ctx.db.get("operations", accepted.operationId)))!;
  expect(op.sourceKeyId).toBeUndefined();
  expect(op.sourceMembershipId).toBe(owner.membershipId);
  // The console batch and its operation belong to the organization's console project.
  const owned = await f.t.run(async (ctx) => ({
    batch: (await ctx.db.get("imports", batch.importId))!.projectId,
    project: (await ctx.db.get("projects", op.projectId))!,
  }));
  expect(owned.batch).toBe(op.projectId);
  expect(owned.project).toMatchObject({ kind: "console", externalReference: "" });
  // No API key reaches what the console imported, even the organization's own key.
  expect(
    (await f.request(`/v1/imports/${batch.importId}`, "GET", undefined, "console-read")).status,
  ).toBe(404);
  await f.t.run((ctx) =>
    ctx.db.patch("memberships", owner.membershipId, { state: "removed", version: 2 }),
  );
  await f.t.action(internal.operationWorker.run, { operationId: op._id, generation: 1 });
  expect((await f.t.run((ctx) => ctx.db.get("operations", op._id)))!.state).toBe("paused");
  await expect(owner.query(api.imports.get, { importId: batch.importId })).rejects.toThrow();
});
it("cancelamento do painel distingue arquivo aceito e não reabre o envio cancelado", async () => {
  const f = await fixture(),
    owner = await person(f.t, f.scope.organizationId, "owner");
  const spec = (name: string) => ({
    name,
    size: f.bytes.length,
    sha256: createHash("sha256").update(f.bytes).digest("hex"),
  });
  const batch = await owner.mutation(api.imports.reserve, {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox",
    key: "cancel-race",
    files: [spec("a.xml"), spec("b.xml")],
  });
  const [a, b] = batch.fileIds as [Id<"importFiles">, Id<"importFiles">];
  const ticket = await owner.mutation(api.imports.upload, { fileId: a });
  const late = await owner.mutation(api.imports.upload, { fileId: b });
  await f.t.fetch("/v1/import-upload", {
    method: "POST",
    headers: { "X-Upload-Token": ticket.token },
    body: new Uint8Array(f.bytes),
  });
  const accepted = await owner.mutation(api.imports.confirm, { fileId: a });
  // A confirmed before the cancel reached the server: it keeps its real state.
  await expect(owner.mutation(api.imports.cancel, { fileId: a })).rejects.toThrow(
    "ALREADY_ACCEPTED",
  );
  await owner.mutation(api.imports.cancel, { fileId: b });
  // Repeating the cancel is harmless, and a ticket issued before it no longer uploads.
  await owner.mutation(api.imports.cancel, { fileId: b });
  expect(
    (
      await f.t.fetch("/v1/import-upload", {
        method: "POST",
        headers: { "X-Upload-Token": late.token },
        body: new Uint8Array(f.bytes),
      })
    ).status,
  ).not.toBe(200);
  await expect(owner.mutation(api.imports.upload, { fileId: b })).rejects.toThrow("UPLOAD_EXPIRED");
  await expect(owner.mutation(api.imports.confirm, { fileId: b })).rejects.toThrow(
    "UPLOAD_EXPIRED",
  );
  const files = await f.t.run(async (ctx) => [
    await ctx.db.get("importFiles", a),
    await ctx.db.get("importFiles", b),
  ]);
  expect(files.map((file) => [file?.state, file?.operationId ?? null])).toEqual([
    ["accepted", accepted.operationId],
    ["expired", null],
  ]);
  // Confirming A again recovers the same operation instead of creating another.
  expect(await owner.mutation(api.imports.confirm, { fileId: a })).toEqual({
    operationId: accepted.operationId,
    reused: true,
  });
});
it("envio sem resposta: reconsulta, ticket novo e confirmação não duplicam o arquivo", async () => {
  const f = await fixture(),
    owner = await person(f.t, f.scope.organizationId, "owner");
  const spec = (name: string) => ({
    name,
    size: f.bytes.length,
    sha256: createHash("sha256").update(f.bytes).digest("hex"),
  });
  const scope = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
  };
  const batch = await owner.mutation(api.imports.reserve, {
    ...scope,
    key: "no-answer",
    files: [spec("a.xml"), spec("b.xml")],
  });
  const [a, b] = batch.fileIds as [Id<"importFiles">, Id<"importFiles">];
  const send = (token: string) =>
    f.t.fetch("/v1/import-upload", {
      method: "POST",
      headers: { "X-Upload-Token": token },
      body: new Uint8Array(f.bytes),
    });
  const stored = () =>
    f.t.run(async (ctx) => (await ctx.db.system.query("_storage").take(10)).length);
  const states = async () =>
    (
      await owner.query(api.imports.get, {
        importId: batch.importId,
        expectedScope: scope,
        includeResults: false,
      })
    ).files.map((file) => file.state);
  // A arrived, but the browser gave up before the answer. The re-query says so.
  const first = await owner.mutation(api.imports.upload, { fileId: a });
  expect((await send(first.token)).status).toBe(200);
  expect(await states()).toEqual(["uploaded", "reserved"]);
  // Even a client that resends anyway gets no second blob and no second ticket.
  expect((await send(first.token)).status).not.toBe(200);
  await expect(owner.mutation(api.imports.upload, { fileId: a })).rejects.toThrow("UPLOAD_EXPIRED");
  expect(await stored()).toBe(1);
  const accepted = await owner.mutation(api.imports.confirm, { fileId: a });
  expect(await owner.mutation(api.imports.confirm, { fileId: a })).toEqual({
    ...accepted,
    reused: true,
  });
  // Reading the state is open to a viewer of the company; a new ticket is not.
  const viewer = await person(f.t, f.scope.organizationId, "viewer");
  await companyGrant(f.t, {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    membershipId: viewer.membershipId,
  });
  expect(
    (await viewer.query(api.imports.get, { importId: batch.importId })).files.map((x) => x.state),
  ).toEqual(["queued", "reserved"]);
  await expect(viewer.mutation(api.imports.upload, { fileId: b })).rejects.toThrow("SCOPE_DENIED");
  // B's request never reached the server before the timeout; resuming asks for a new ticket.
  const lost = await owner.mutation(api.imports.upload, { fileId: b });
  const retry = await owner.mutation(api.imports.upload, { fileId: b });
  // The lost request lands late: its token was replaced, so it stores nothing.
  expect((await send(lost.token)).status).not.toBe(200);
  expect(await stored()).toBe(1);
  expect((await send(retry.token)).status).toBe(200);
  await owner.mutation(api.imports.confirm, { fileId: b });
  expect(await stored()).toBe(2);
  expect(await f.t.run((ctx) => ctx.db.query("documentArtifacts").take(5))).toHaveLength(2);
  expect(await f.t.run((ctx) => ctx.db.query("operations").take(5))).toHaveLength(2);
  // The re-query reads nothing of another organization, and a viewer cannot take a ticket.
  const other = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: "other-no-answer-key",
    suffix: "other-no-answer",
  });
  const outsider = await person(f.t, other.organizationId, "owner");
  await expect(
    outsider.query(api.imports.get, { importId: batch.importId, includeResults: false }),
  ).rejects.toThrow("ACCESS_DENIED");
  await expect(
    owner.query(api.imports.get, {
      importId: batch.importId,
      expectedScope: { ...scope, companyId: other.companyId },
    }),
  ).rejects.toThrow("NOT_FOUND");
});
it("ticket de upload vencido ou de pessoa com acesso trocado não guarda blob nem reserva bytes (#134)", async () => {
  const f = await fixture(),
    owner = await person(f.t, f.scope.organizationId, "owner");
  const spec = (name: string) => ({
    name,
    size: f.bytes.length,
    sha256: createHash("sha256").update(f.bytes).digest("hex"),
  });
  const batch = await owner.mutation(api.imports.reserve, {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox",
    key: "denied-ticket",
    files: [spec("a.xml"), spec("b.xml")],
  });
  const [a, b] = batch.fileIds as [Id<"importFiles">, Id<"importFiles">];
  const send = async (token: string) => {
    const response = await f.t.fetch("/v1/import-upload", {
      method: "POST",
      headers: { "X-Upload-Token": token },
      body: new Uint8Array(f.bytes),
    });
    const body = (await response.json()) as { error?: { code: string } };
    return { status: response.status, code: body.error?.code };
  };
  const effects = () =>
    f.t.run(async (ctx) => ({
      blobs: (await ctx.db.system.query("_storage").take(10)).length,
      capacity: (await ctx.db.query("capacityEvents").collect()).length,
      files: (await Promise.all([a, b].map((id) => ctx.db.get("importFiles", id)))).map((file) => [
        file?.state,
        file?.storageId ?? null,
      ]),
    }));
  const before = await effects();
  expect(before.files).toEqual([
    ["reserved", null],
    ["reserved", null],
  ]);
  // The token lives 15 minutes and the reservation a day: past the token, only the token expired.
  const expired = await owner.mutation(api.imports.upload, { fileId: a });
  vi.setSystemTime(expired.expiresAt);
  expect(await send(expired.token)).toEqual({ status: 409, code: "UPLOAD_EXPIRED" });
  // The member's access changed after the ticket was issued: still a manager, another version.
  const changed = await owner.mutation(api.imports.upload, { fileId: b });
  await f.t.run((ctx) =>
    ctx.db.patch("memberships", owner.membershipId, { role: "admin", version: 2 }),
  );
  expect(await send(changed.token)).toEqual({ status: 409, code: "ACCESS_REVOKED" });
  expect(await effects()).toEqual(before);
  // Control: a ticket issued now, under the current access, uploads the same file.
  const fresh = await owner.mutation(api.imports.upload, { fileId: a });
  expect((await send(fresh.token)).status).toBe(200);
});
it("leitura não reserva importação e operador precisa da concessão da empresa", async () => {
  const f = await fixture(),
    viewer = await person(f.t, f.scope.organizationId, "viewer"),
    operator = await person(f.t, f.scope.organizationId, "operator");
  const args = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
    key: "human",
    files: [
      {
        name: "nota.xml",
        size: f.bytes.length,
        sha256: createHash("sha256").update(f.bytes).digest("hex"),
      },
    ],
  };
  await expect(viewer.mutation(api.imports.reserve, args)).rejects.toThrow("NOT_FOUND");
  await expect(operator.mutation(api.imports.reserve, args)).rejects.toThrow("NOT_FOUND");
  for (const member of [viewer, operator])
    await companyGrant(f.t, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      membershipId: member.membershipId,
    });
  // The integration's grant does not matter to people: revoke it entirely.
  await f.t.run(async (ctx) => {
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, { active: false });
  });
  await expect(viewer.mutation(api.imports.reserve, args)).rejects.toThrow("SCOPE_DENIED");
  const reserved = await operator.mutation(api.imports.reserve, args);
  expect(reserved).toHaveProperty("importId");
  // Same key, same request: the console namespace returns the same reservation.
  expect(await operator.mutation(api.imports.reserve, args)).toMatchObject({
    importId: reserved.importId,
    reused: true,
  });
  expect(
    await viewer.query(api.imports.recent, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      environment: "sandbox",
    }),
  ).toEqual([
    {
      id: reserved.importId,
      createdAt: expect.any(Number),
      // Made in the console: the list says so and gives each file's state and result code.
      origin: { kind: "console", integration: null },
      files: [{ state: "reserved", code: null }],
    },
  ]);
  // A developer with access to the company works through integrations, not the console.
  const developer = await person(f.t, f.scope.organizationId, "owner");
  await f.t.run((ctx) =>
    ctx.db.patch("memberships", developer.membershipId, { role: "developer" }),
  );
  await expect(developer.mutation(api.imports.reserve, args)).rejects.toThrow("NOT_FOUND");
  await companyGrant(f.t, {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    membershipId: developer.membershipId,
  });
  await expect(developer.mutation(api.imports.reserve, args)).rejects.toThrow("SCOPE_DENIED");
  await expect(
    developer.query(api.imports.recent, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      environment: "sandbox",
    }),
  ).rejects.toThrow("SCOPE_DENIED");
  // Another organization's owner reaches nothing here.
  const other = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: "other-reserve-key",
    suffix: "other-reserve",
  });
  const outsider = await person(f.t, other.organizationId, "owner");
  await expect(outsider.mutation(api.imports.reserve, args)).rejects.toThrow();
});
it("o XML de exemplo do painel segue a concessão e o papel na empresa de demonstração (#510)", async () => {
  // The console fetches the public example and reserves it like any chosen file: the server
  // decides by the company grant, not by the file being public.
  const example = readFileSync(
      new URL("../../apps/console/public/examples/nfe-demonstracao.xml", import.meta.url),
    ),
    f = await fixture(example);
  const demo = await f.t.run(async (ctx) => {
    const company = (await ctx.db.get("companies", f.scope.companyId))!;
    const { _id, _creationTime, ...fields } = company;
    return ctx.db.insert("companies", {
      ...fields,
      kind: "demonstration",
      cnpj: demonstrationCompany.cnpj,
      name: demonstrationCompany.name,
    });
  });
  const operator = await person(f.t, f.scope.organizationId, "operator"),
    viewer = await person(f.t, f.scope.organizationId, "viewer");
  const grant = (member: { membershipId: Id<"memberships"> }, companyId: Id<"companies">) =>
    companyGrant(f.t, {
      organizationId: f.scope.organizationId,
      companyId,
      membershipId: member.membershipId,
    });
  await grant(operator, f.scope.companyId);
  const reserve = (
    member: typeof operator,
    companyId: Id<"companies">,
    key = `exemplo-${companyId}`,
  ) =>
    member.mutation(api.imports.reserve, {
      organizationId: f.scope.organizationId,
      companyId,
      environment: "sandbox" as const,
      key,
      files: [
        {
          name: "nfe-demonstracao.xml",
          size: example.length,
          sha256: createHash("sha256").update(example).digest("hex"),
        },
      ],
    });
  // Granted only company A: the demonstration company is not found, and nothing is reserved.
  await expect(reserve(operator, demo)).rejects.toThrow("NOT_FOUND");
  expect(await f.t.run((ctx) => ctx.db.query("imports").take(1))).toEqual([]);
  // The grant the operator does hold still takes the same file.
  expect(await reserve(operator, f.scope.companyId)).toMatchObject({ reused: false });
  // Granted the demonstration company, the operator imports into it like any other company.
  await grant(operator, demo);
  expect(await reserve(operator, demo)).toMatchObject({ reused: false });
  // A viewer never reserves: without the grant the company is not found, with it the role is refused.
  await expect(reserve(viewer, demo, "viewer")).rejects.toThrow("NOT_FOUND");
  await grant(viewer, demo);
  await expect(reserve(viewer, demo, "viewer")).rejects.toThrow("SCOPE_DENIED");
  expect(await f.t.run((ctx) => ctx.db.query("imports").take(3))).toHaveLength(2);
});

it("renovar tokens compartilha uma limpeza incremental, sem varredura por token", async () => {
  const f = await fixture(),
    batch = await f.reserve();
  for (let index = 0; index < 10; index++)
    expect(
      (await f.request(`/v1/imports/${batch.importId}/files/${batch.fileIds[0]}/upload`)).status,
    ).toBe(200);
  const maintenance = await f.t.run((ctx) => ctx.db.query("importMaintenance").take(2));
  expect(maintenance).toHaveLength(1);
  const jobs = await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(50));
  expect(jobs.filter((job) => job.name === "importUpload:cleanup")).toHaveLength(1);
  expect(jobs.filter((job) => job.name === "importUpload:sweep")).toHaveLength(0);
  vi.setSystemTime(maintenance[0]!.nextAt!);
  await f.t.mutation(internal.importUpload.cleanup, {});
  const next = (await f.t.run((ctx) => ctx.db.query("importMaintenance").first()))!;
  expect(next.lastSweptAt).toBeGreaterThan(maintenance[0]!.lastSweptAt);
});
it("cleanup coverage is coalesced, extends monotonically, and rearms after the scanner stops", async () => {
  const f = await fixture();
  const until = Date.now() + 90_001;
  const requestedUntil = Math.ceil(until / 60_000) * 60_000;
  await f.t.run((ctx) => requestCleanup(ctx, until));
  const state = (await f.t.run((ctx) => ctx.db.query("importMaintenance").unique()))!;
  expect(state.requestedUntil).toBe(requestedUntil);
  await f.t.run((ctx) => requestCleanup(ctx, until + 1));
  expect(await f.t.run((ctx) => ctx.db.get("importMaintenance", state._id))).toEqual(state);
  await f.t.run((ctx) => requestCleanup(ctx, requestedUntil + 1));
  const extended = (await f.t.run((ctx) => ctx.db.get("importMaintenance", state._id)))!;
  expect(extended.requestedUntil).toBe(requestedUntil + 60_000);
  expect(extended.nextAt).toBe(state.nextAt);
  vi.setSystemTime(extended.requestedUntil + 30 * 60_000);
  await f.t.mutation(internal.importUpload.cleanup, {});
  const stopped = (await f.t.run((ctx) => ctx.db.get("importMaintenance", state._id)))!;
  expect(stopped.nextAt).toBeUndefined();
  expect(stopped.lastSweptAt).toBe(extended.requestedUntil);
  await f.t.run((ctx) => requestCleanup(ctx, until));
  const rearmed = (await f.t.run((ctx) => ctx.db.get("importMaintenance", state._id)))!;
  expect(rearmed.nextAt).toBeGreaterThan(Date.now());
  expect(rearmed.requestedUntil).toBe(extended.requestedUntil);
});
it("token expirado não aceita bytes e reserva vencida remove upload não confirmado", async () => {
  const f = await fixture(),
    batch = await f.reserve();
  const response = await f.request(
      `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}/upload`,
    ),
    ticket = (await response.json()).data;
  vi.setSystemTime(ticket.expiresAt);
  expect(
    (
      await f.t.fetch("/v1/import-upload", {
        method: "POST",
        headers: { "X-Upload-Token": ticket.token },
        body: new Uint8Array(f.bytes),
      })
    ).status,
  ).toBe(409);
  expect((await f.upload(batch)).status).toBe(200);
  const file = (await f.t.run((ctx) => ctx.db.get("importFiles", batch.fileIds[0]!)))!;
  vi.setSystemTime(file.expiresAt);
  await f.t.mutation(internal.imports.expire, { importId: batch.importId });
  expect(await f.t.run((ctx) => ctx.db.system.get("_storage", file.storageId!))).toBeNull();
  expect((await f.t.run((ctx) => ctx.db.get("importFiles", file._id)))!.state).toBe("expired");
});
