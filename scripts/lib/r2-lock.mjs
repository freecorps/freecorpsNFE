import assert from "node:assert/strict";

/** R2 accepts at most this many lock rules per bucket. */
export const R2_LOCK_RULE_LIMIT = 1000;
const DAY = 86_400_000;

/** The rule of one cold run: its own prefix, so a renewal never touches another run's objects. */
export const runLockRule = (prefix, runId) => ({
  id: `fnfe-cold-${runId}`,
  prefix: `${prefix}${runId}/`,
});
/** R2 locks by whole days: the first UTC midnight at or after `until`. */
export const lockDate = (until) => new Date(Math.ceil(until / DAY) * DAY).toISOString();

/**
 * The bucket lock rules of R2 through the Cloudflare API (ADR 0009, §2, "Prazo do pacote").
 * The API only replaces the whole rule set, so every write rereads it and keeps every other rule
 * exactly as it found it. A single operator runs this; two concurrent writers could drop a rule
 * the other just added, which the read-back after the write detects for this run's rule.
 */
export function r2LockClient({ accountId, bucket, token, fetchImpl = fetch }) {
  assert.ok(token, "Token da API Cloudflare para os locks do R2 ausente");
  assert.match(accountId, /^[a-f0-9]{32}$/, "Conta Cloudflare inválida");
  assert.match(bucket, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, "Bucket inválido");
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/lock`;
  async function send(method, body) {
    const response = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    // Provider error bodies can echo request details; only the status leaves this function.
    if (!response.ok) throw new Error(`R2 lock ${method}: HTTP ${response.status}`);
    const json = await response.json();
    assert.equal(json?.success, true, `R2 lock ${method} recusado`);
    return json.result;
  }
  const rules = async () => {
    const result = await send("GET");
    assert.ok(Array.isArray(result?.rules), "Resposta de lock sem regras");
    return result.rules;
  };
  /** The date (ms) up to which the rule `id` locks `prefix`, Infinity if indefinite, or null. */
  const lockedUntil = (all, { id, prefix }) => {
    const rule = all.find((r) => r.id === id);
    if (!rule) return null;
    assert.equal(rule.prefix, prefix, "Regra de lock com outro prefixo; exige revisão");
    if (!rule.enabled) return null;
    // Never weaken a rule someone made stronger by hand; an age rule needs a person to decide.
    if (rule.condition?.type === "Indefinite") return Infinity;
    assert.equal(rule.condition?.type, "Date", "Regra de lock sem data; exige revisão");
    const date = Date.parse(rule.condition.date);
    assert.ok(Number.isFinite(date), "Data de lock inválida");
    return date;
  };
  return {
    rules,
    /**
     * Makes the run's rule lock its prefix at least until `until` and returns the locked date.
     * Only extends: an existing later date stays. Rereads the rules after the write.
     */
    async ensure({ id, prefix }, until) {
      assert.ok(Number.isSafeInteger(until) && until > Date.now(), "Prazo de lock inválido");
      const before = await rules(),
        current = lockedUntil(before, { id, prefix });
      if (current !== null && current >= until) return current;
      const others = before.filter((r) => r.id !== id);
      assert.ok(others.length < R2_LOCK_RULE_LIMIT, "Limite de regras de lock do bucket atingido");
      const date = lockDate(Math.max(until, current ?? 0));
      await send("PUT", {
        rules: [...others, { id, enabled: true, prefix, condition: { type: "Date", date } }],
      });
      const after = await rules(),
        locked = lockedUntil(after, { id, prefix });
      assert.ok(locked !== null && locked >= until, "Lock do R2 não confirmado");
      for (const rule of others)
        assert.ok(
          after.some((r) => r.id === rule.id),
          "Outra regra de lock sumiu durante a escrita; exige revisão",
        );
      return locked;
    },
    /** The locked date of the run's rule, or null. */
    async lockedUntil(rule) {
      return lockedUntil(await rules(), rule);
    },
  };
}
