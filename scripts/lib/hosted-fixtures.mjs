import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const scopeFields = ({ organizationId, projectId, companyId }) => ({
  organizationId,
  projectId,
  companyId,
  environment: "sandbox",
});
export const headers = (s) => ({
  Authorization: `Bearer ${s.secret}`,
  "X-Environment": "sandbox",
  "Content-Type": "application/json",
});

export async function prepareScope(h, suffix) {
  const now = Date.now();
  async function one(table, document, index, fields) {
    await h.add(table, [document]);
    const rows = await h.rows(table, index, fields, 2);
    assert.equal(rows.length, 1);
    return rows[0]._id;
  }
  const organizationId = await one(
    "organizations",
    {
      name: "Ensaio hospedado 79-80",
      slug: suffix,
      ownerCount: 1,
      memberCount: 1,
      createdAt: now,
      updatedAt: now,
    },
    "by_slug",
    { slug: suffix },
  );
  const ownerMembershipId = await one(
    "memberships",
    {
      organizationId,
      authUserId: suffix,
      name: "Ensaio sintético",
      email: `${suffix}@validation.invalid`,
      role: "owner",
      state: "active",
      version: 1,
      joinedAt: now,
      updatedAt: now,
    },
    "by_organizationId_and_state",
    { organizationId, state: "active" },
  );
  const companyId = await one(
    "companies",
    {
      organizationId,
      cnpj: "00000000000191",
      name: "Empresa sintética",
      kind: "demonstration",
      declaredBy: suffix,
      declaredAt: now,
      address: {
        street: "Rua sintética",
        number: "1",
        complement: "",
        district: "Centro",
        city: "Cidade",
        state: "SP",
        postalCode: "01000000",
      },
      fieldSources: { name: "demonstration", address: "demonstration" },
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
    "by_organizationId",
    { organizationId },
  );
  const projectId = await one(
    "projects",
    {
      organizationId,
      name: "Ensaio sintético",
      externalReference: suffix,
      state: "active",
      version: 1,
      accessEpoch: 0,
      creatorMembershipId: ownerMembershipId,
      creatorEpoch: 0,
      createdAt: now,
    },
    "by_organizationId",
    { organizationId },
  );
  const scopes = ["documents:import", "documents:read", "connections:write", "webhooks:manage"];
  await h.add("projectCompanies", [
    {
      organizationId,
      projectId,
      companyId,
      scopes,
      environments: ["sandbox"],
      active: true,
      version: 1,
      accessEpoch: 0,
    },
  ]);
  const secret = `fnfe_${randomBytes(32).toString("base64url")}`,
    keyHash = hash(secret);
  const keyId = await one(
    "apiKeys",
    {
      organizationId,
      projectId,
      projectEpoch: 0,
      name: "Ensaio hospedado",
      keyHash,
      prefix: "fnfe_proof",
      scopes,
      environment: "sandbox",
      companyIds: [companyId],
      grantEpochs: [0],
      expiresAt: now + 86400000,
      revokedAt: null,
      rotatedAt: null,
      createdAt: now,
      creatorMembershipId: ownerMembershipId,
    },
    "by_keyHash",
    { keyHash },
  );
  return {
    organizationId,
    projectId,
    companyId,
    keyId,
    secret,
    keyHash,
    ownerMembershipId,
    suffix,
  };
}

export async function importSource(h, s) {
  const root = new URL("../../tests/fixtures/nfe/4.00/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
  const xml = readFileSync(
    new URL(manifest.cases.find((c) => c.id === "invoice-signed").path, root),
  );
  const cnpj = /<emit>\s*<CNPJ>(\d{14})<\/CNPJ>/.exec(xml.toString("utf8"))?.[1];
  assert.ok(cnpj, "Synthetic fixture issuer absent");
  await h.patch("companies", [s.companyId], { cnpj });
  const response = await fetch(`${h.target.siteUrl}/v1/imports`, {
    method: "POST",
    headers: { ...headers(s), "Idempotency-Key": randomUUID() },
    body: JSON.stringify({
      companyId: s.companyId,
      files: [{ name: "synthetic.xml", size: xml.length, sha256: hash(xml) }],
    }),
  });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  const path = `/v1/imports/${data.importId}/files/${data.fileIds[0]}`;
  const ticketResponse = await fetch(`${h.target.siteUrl}${path}/upload`, {
    method: "POST",
    headers: headers(s),
    body: "{}",
  });
  assert.equal(ticketResponse.status, 200);
  const { data: ticket } = await ticketResponse.json();
  assert.equal(new URL(ticket.url).origin, h.target.siteUrl);
  const uploaded = await fetch(ticket.url, {
    method: "POST",
    headers: {
      "X-Upload-Token": ticket.token,
      "Content-Type": "application/vnd.freecorps.import+xml",
    },
    body: xml,
  });
  assert.equal(uploaded.status, 200);
  const confirmed = await fetch(`${h.target.siteUrl}${path}/confirm`, {
    method: "POST",
    headers: headers(s),
    body: "{}",
  });
  assert.equal(confirmed.status, 200);
  for (let i = 0; i < 60; i++) {
    const docs = await h.rows(
      "fiscalDocuments",
      "by_companyId_environment_listedAt",
      { companyId: s.companyId, environment: "sandbox" },
      2,
    );
    if (docs[0]?.publishedVersionId && docs[0]?.listedAt) {
      const doc = docs[0];
      const version = await h.query(
        `return await ctx.db.get(${JSON.stringify(doc.publishedVersionId)});`,
      );
      return { doc, version, sha256: hash(xml) };
    }
    await delay(1000);
  }
  throw new Error("Synthetic import did not publish within 60 polls");
}

export async function seedMetadata(h, s, source, offset, count) {
  const { _id, _creationTime, documentId, ...version } = source.version;
  void _id;
  void _creationTime;
  void documentId;
  const stamp = Date.now();
  await h.add(
    "documentVersions",
    Array.from({ length: count }, (_, i) => ({
      ...version,
      createdAt: stamp + i,
      code: `HOSTED_PROOF_${offset + i}`,
    })),
  );
  const versions = await h.rows(
    "documentVersions",
    "by_artifactId",
    { artifactId: version.artifactId },
    count,
    ["_id", "code"],
  );
  assert.equal(versions.length, count);
  assert.ok(versions.every((v) => v.code.startsWith("HOSTED_PROOF_")));
  const documents = versions.map((v, i) => ({
    organizationId: s.organizationId,
    companyId: s.companyId,
    environment: "sandbox",
    model: "55",
    fiscalKey: source.doc.fiscalKey.slice(0, 22) + String(offset + i).padStart(22, "0"),
    publishedVersionId: v._id,
    completeness: source.doc.completeness,
    createdAt: stamp + i,
    listedAt: stamp,
    projectionState: "ready",
    projectionGeneration: 1,
    publicVersion: 1,
    ...(source.doc.fiscalSituation ? { fiscalSituation: source.doc.fiscalSituation } : {}),
  }));
  await h.add("fiscalDocuments", documents);
  const docs = (
    await h.rows(
      "fiscalDocuments",
      "by_companyId_environment_listedAt",
      { companyId: s.companyId, environment: "sandbox" },
      count + 1,
      ["_id", "createdAt", "fiscalKey"],
    )
  ).filter(
    (d) =>
      d._id !== source.doc._id &&
      Number(d.fiscalKey.slice(22)) >= offset &&
      Number(d.fiscalKey.slice(22)) < offset + count,
  );
  assert.equal(
    docs.length,
    count,
    "Synthetic batch lost a document to concurrent projection ordering",
  );
  const status = source.doc.fiscalSituation?.reportedStatus ?? "unknown";
  await h.add(
    "documentListings",
    docs.flatMap((d) =>
      ["*:*", "*:imported-xml", `${status}:*`, `${status}:imported-xml`].map((filterKey) => ({
        documentId: d._id,
        companyId: s.companyId,
        environment: "sandbox",
        filterKey,
        date: d.createdAt,
      })),
    ),
  );
  return {
    documents: count,
    logicalBytes:
      Buffer.byteLength(JSON.stringify(documents)) +
      count * Buffer.byteLength(JSON.stringify(version)),
  };
}
