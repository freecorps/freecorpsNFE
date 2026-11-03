import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export async function loadReadFixtures(fixturePath) {
  try {
    const fixtures = JSON.parse(await readFile(fixturePath, "utf8"));
    assert.ok(Array.isArray(fixtures) && fixtures.length === 5);
    const matrix = { "55/invoice": 1, "nfse/service-invoice-batch": 1, "nfse/service-invoice": 3 };
    const results = new Set();
    for (const fixture of fixtures) {
      const key = `${fixture.model}/${fixture.kind}`;
      assert.ok(Object.hasOwn(matrix, key) && matrix[key] > 0);
      matrix[key]--;
      const content = fixture.content;
      assert.ok(typeof content.result === "string" && Array.isArray(content.items));
      const result = JSON.parse(content.result);
      if (fixture.kind === "service-invoice-batch") assert.equal(result?.documentCount, 3);
      else assert.equal(result?.document?.kind, fixture.kind);
      assert.ok(!results.has(content.result));
      results.add(content.result);
      for (const item of content.items) {
        assert.equal(typeof item, "string");
        JSON.parse(item);
      }
      if (fixture.model === "55") {
        assert.ok(
          typeof content.fiscalEvidence === "string" && typeof content.snapshot === "string",
        );
        assert.ok(JSON.parse(content.fiscalEvidence));
        assert.ok(JSON.parse(content.snapshot));
      }
    }
    assert.ok(Object.values(matrix).every((count) => count === 0));
    return fixtures;
  } catch {
    throw new Error("READ_FIXTURES_INVALID");
  }
}

export async function readProof({ call, scope, storageId, report, fixtures, node = false }) {
  report.revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  report.localChanges = true;
  report.versions = {
    convex: JSON.parse(await readFile("platform/node_modules/convex/package.json", "utf8")).version,
    fflate: JSON.parse(await readFile("platform/node_modules/fflate/package.json", "utf8")).version,
    runner: process.version,
    backend: "unavailable",
  };
  const { keyId: _key, ...ids } = scope;
  const action = async (versionId, inline) => {
    const raw = await call("action", "testing/documentReadProof:read", { versionId, inline });
    return { raw, value: JSON.parse(raw) };
  };
  const nodeAction = async (versionId, inline) => {
    const envelope = JSON.parse(
      await call("action", "testing/documentReadNodeProof:read", { versionId, inline }),
    );
    return { ...envelope, value: JSON.parse(envelope.payload) };
  };
  const project = (c) => ({
    result: JSON.parse(c.result),
    items: c.items.map((item) => JSON.parse(item)),
    ...(c.fiscalEvidence ? { fiscalEvidence: JSON.parse(c.fiscalEvidence) } : {}),
    ...(c.snapshot ? { snapshot: JSON.parse(c.snapshot) } : {}),
  });
  for (const fixture of fixtures) {
    // Same amount of deterministic high-entropy text, two item distributions, one version at a time.
    for (const [count, width] of [
      [512, 13000],
      [16, 480000],
    ]) {
      const row = { model: fixture.model, kind: fixture.kind, count, width, outcome: "pending" };
      report.results.push(row);
      let phase = "prepare";
      try {
        const content = structuredClone(fixture.content);
        content.items = Array.from({ length: count }, (_, position) => {
          let text = 'ação 漢字 😀 " \\ \n';
          for (let block = 0; text.length < width; block++)
            text += createHash("sha256").update(`${position}:${block}`).digest("base64");
          return JSON.stringify({
            original: content.items[position % Math.max(1, content.items.length)] ?? null,
            position,
            decimal: "12345678901234567890.0012300",
            text: text.slice(0, width),
          });
        });
        const seeded = await call("mutation", "testing/documentContentProof:seed", {
          ...ids,
          storageId,
          model: fixture.model,
        });
        const { versionId } = seeded;
        if (node && !report.calibration) {
          report.calibration = JSON.parse(
            await call("action", "testing/documentReadNodeProof:calibrate", { versionId }),
          );
          assert.ok(
            report.calibration.afterBuffer.arrayBuffers - report.calibration.before.arrayBuffers >=
              report.calibration.allocatedBytes,
          );
          assert.equal(report.calibration.checksum, 100072);
          report.instrumentUseful = true;
          report.adversaries = JSON.parse(
            await call("action", "testing/documentReadNodeProof:adversaries", { versionId }),
          );
        }
        await call("mutation", "testing/documentReadProof:configure", {
          versionId,
          batch: fixture.kind === "service-invoice-batch",
          result: content.result,
          fiscalEvidence: content.fiscalEvidence,
          items: [],
        });
        for (
          let offset = 0;
          offset < content.items.length;
          offset += Math.min(64, Math.max(1, Math.floor(400000 / (width + 4096))))
        ) {
          const batch = Math.min(64, Math.max(1, Math.floor(400000 / (width + 4096))));
          await call("mutation", "testing/documentReadProof:configure", {
            versionId,
            items: content.items.slice(offset, offset + batch),
          });
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        phase = "fallback";
        const fallback = await action(versionId, false);
        const before = { ...content };
        delete before.snapshot;
        assert.equal(fallback.value.source, "inline");
        assert.deepEqual(fallback.value.projection, project(before));
        if (node) {
          const candidate = await nodeAction(versionId, false);
          assert.deepEqual(candidate.value.projection, fallback.value.projection);
          row.fallbackMemory = candidate.samples;
        }
        row.fallback = true;
        phase = "publication";
        await call("mutation", "importProcessing:published", { operationId: seeded.operationId });
        let resolved;
        for (let i = 0; i < 120; i++) {
          resolved = JSON.parse(
            await call("query", "testing/documentReadProof:resolve", { versionId, inline: false }),
          );
          if (resolved.storageId) break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        assert.ok(resolved.storageId);
        const canonical = JSON.stringify({
          format: "document-content/1",
          result: content.result,
          ...(content.fiscalEvidence ? { fiscalEvidence: content.fiscalEvidence } : {}),
          items: content.items,
          ...(content.snapshot ? { snapshot: content.snapshot } : {}),
        });
        assert.equal(
          resolved.ref.contentSha256,
          createHash("sha256").update(canonical).digest("hex"),
        );
        assert.equal(resolved.ref.contentSize, Buffer.byteLength(canonical));
        phase = "return";
        const inline = await action(versionId, true);
        const blob = await action(versionId, false);
        assert.equal(blob.value.source, "blob");
        assert.deepEqual(blob.value.projection, project(content));
        assert.deepEqual(blob.value.projection, inline.value.projection);
        row.canonicalBytes = resolved.ref.contentSize;
        row.compressedBytes = blob.value.storedSize;
        row.returnBytes = Buffer.byteLength(blob.raw);
        row.items = blob.value.projection.items.length;
        row.metrics = { inline: inline.value.metrics, blob: blob.value.metrics };
        if (node) {
          const candidateInline = await nodeAction(versionId, true);
          const candidateBlob = await nodeAction(versionId, false);
          assert.deepEqual(candidateInline.value.projection, inline.value.projection);
          assert.deepEqual(candidateBlob.value.projection, blob.value.projection);
          assert.equal(candidateBlob.value.source, "blob");
          row.node = {
            runtime: candidateBlob.runtime,
            inline: candidateInline.samples,
            blob: candidateBlob.samples,
          };
        }
        phase = "errors";
        await call("mutation", "testing/documentReadProof:damage", { versionId, missing: false });
        await assert.rejects(action(versionId, false), /DOCUMENT_CONTENT_CORRUPT/);
        if (node) await assert.rejects(nodeAction(versionId, false), /DOCUMENT_CONTENT_CORRUPT/);
        await call("mutation", "testing/documentReadProof:damage", { versionId, missing: true });
        await assert.rejects(action(versionId, false), /BLOB_MISSING/);
        if (node) await assert.rejects(nodeAction(versionId, false), /BLOB_MISSING/);
        row.errors = ["DOCUMENT_CONTENT_CORRUPT", "BLOB_MISSING"];
        row.outcome = "passed";
      } catch {
        row.outcome = "failed";
        row.error = `READ_${phase.toUpperCase()}_FAILED`;
        if (node && !report.instrumentUseful) throw new Error("MEMORY_INSTRUMENT_UNPROVEN");
      }
      console.log(JSON.stringify(row));
    }
  }
  assert.ok(
    report.results.length === 10 && report.results.every((row) => row.outcome === "passed"),
    "READ_PROOF_FAILED",
  );
}
