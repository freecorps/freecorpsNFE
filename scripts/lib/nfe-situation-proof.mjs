import assert from "node:assert/strict";

/** Runs against processed XML, including real synthetic signatures, without changing evidence. */
export function proveExcludedEvents(cases, derive) {
  const get = (id) => {
    const result = cases.find((entry) => entry.id === id)?.result;
    assert.ok(result, `Missing corpus case: ${id}`);
    return result;
  };
  const authorized = get("invoice-authorized"),
    accepted = get("event-110111");
  const baseline = derive([authorized, accepted]);
  assert.equal(baseline.reportedStatus, "cancelled");
  assert.deepEqual(baseline.conflicts, []);
  const receipts = [];
  for (const id of [
    "event-rejected-conflicting-claims",
    "event-unlinked-conflicting-claims",
    "event-rejected-other-identity",
  ]) {
    const excluded = get(id),
      unchanged = JSON.stringify(excluded);
    for (const stage of ["parsing", "xsd", "signature", "identity", "fiscalEvidence"])
      assert.equal(excluded.checks[stage].status, "passed", `${id}:${stage}`);
    const expected = {
      ...baseline,
      excluded: [
        {
          id: excluded.metadata.originalSha256,
          reason: "EVENT_DOES_NOT_CHANGE_FISCAL_STATUS",
        },
      ],
    };
    const orders = [
      [authorized, accepted, excluded],
      [authorized, excluded, accepted],
      [accepted, authorized, excluded],
      [accepted, excluded, authorized],
      [excluded, authorized, accepted],
      [excluded, accepted, authorized],
      [excluded, accepted, authorized, excluded, accepted, authorized],
    ];
    for (const order of orders) assert.deepEqual(derive(order), expected, id);
    assert.equal(derive([authorized, excluded]).reportedStatus, "authorized", id);
    const alone = derive([excluded]);
    assert.equal(alone.reportedStatus, "unknown", id);
    assert.equal(alone.key, null, id);
    assert.deepEqual(alone.conflicts, [], id);
    assert.equal(JSON.stringify(excluded), unchanged);
    receipts.push({ id, orders: orders.length, result: "passed", situation: expected });
  }
  const conflict = derive([authorized, accepted, get("event-accepted-conflicting-claims")]);
  assert.equal(conflict.reportedStatus, "conflict");
  // An accepted cancellation must come from the issuer (#532), so only the instant diverges.
  for (const prefix of ["IMMUTABLE_CLAIM_CONFLICT:EVENT_TIME:", "EVENT_IDENTITY_CONFLICT:"])
    assert.ok(
      conflict.conflicts.some((code) => code.startsWith(prefix)),
      prefix,
    );
  return { result: "passed", excluded: receipts, acceptedControl: conflict };
}
