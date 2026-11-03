import assert from "node:assert/strict";

/**
 * Lock rules of the cold tier's bucket (ADR 0010, decision 6). R2 has no retention per object,
 * only rules by prefix, so the key carries the year the fiscal guard of a Production note ends
 * (`documents/production/guard-<year>/...`, `platform/convex/lib/coldObjects.ts`), and one Date
 * rule per year locks it until the guard ends: 01/01 of the next year, 00:00 in Brasília. Sandbox
 * notes are not locked. A package of ADR 0009 that references cold notes extends their lock to
 * its own `retainUntil` with a rule per organization and year. A rule is never shortened nor
 * removed here.
 */
const BRASILIA = 3 * 3_600_000;
const MAX_RULES = 1000;
export const guardEnd = (year) => new Date(Date.UTC(year + 1, 0, 1) + BRASILIA).toISOString();
export const yearPrefix = (year) => `documents/production/guard-${year}/`;

/** The yearly rules from `from` to `through`, inclusive. */
export function yearRules(from, through) {
  assert.ok(
    Number.isSafeInteger(from) && Number.isSafeInteger(through) && from <= through,
    "Anos de guarda inválidos",
  );
  assert.ok(through - from < 100, "Anos de guarda inválidos");
  const rules = [];
  for (let year = from; year <= through; year++)
    rules.push({
      id: `guard-${year}`,
      enabled: true,
      prefix: yearPrefix(year),
      condition: { type: "Date", date: guardEnd(year) },
    });
  return rules;
}

/**
 * Rules of a package: each organization and guard year it references in Production, locked
 * until the package's `retainUntil` when that is later than the year's own end.
 */
export function packageRules({ runId, retainUntil, references }) {
  assert.ok(/^[A-Za-z0-9_-]+$/.test(runId) && Number.isSafeInteger(retainUntil));
  const prefixes = new Map();
  for (const { key } of references) {
    const match = /^documents\/production\/guard-(\d{4})\/([A-Za-z0-9]+)\//.exec(key);
    if (!match) continue;
    const year = Number(match[1]);
    if (Date.parse(guardEnd(year)) < retainUntil)
      prefixes.set(`${yearPrefix(year)}${match[2]}/`, year);
  }
  return [...prefixes].map(([prefix, year]) => ({
    id: `archive-${runId}-${year}`,
    enabled: true,
    prefix,
    condition: { type: "Date", date: new Date(retainUntil).toISOString() },
  }));
}

/**
 * Until when a rule locks: its date, forever when indefinite, and not at all for any other
 * condition (an age counts from each object's upload, which says nothing about the guard).
 */
const lockedUntil = (rule) =>
  rule?.enabled === false
    ? -Infinity
    : rule?.condition?.type === "Date"
      ? Date.parse(rule.condition.date)
      : rule?.condition?.type === "Indefinite"
        ? Infinity
        : -Infinity;

/**
 * The bucket's rules plus `wanted`: a new rule is added; an existing one with the same id is
 * replaced only to lock longer. Returns `null` when nothing changes.
 */
export function mergeRules(existing, wanted) {
  const rules = new Map(existing.map((rule) => [rule.id, rule]));
  let changed = false;
  for (const rule of wanted) {
    const current = rules.get(rule.id);
    if (current) {
      assert.equal(current.prefix, rule.prefix, "Regra de lock com prefixo divergente");
      if (lockedUntil(current) >= lockedUntil(rule)) continue;
    }
    rules.set(rule.id, rule);
    changed = true;
  }
  assert.ok(rules.size <= MAX_RULES, "Limite de regras de lock do bucket");
  return changed ? [...rules.values()] : null;
}

/** The lock configuration of one bucket, through the Cloudflare API (an R2 admin token). */
export function cloudflareLocks({ accountId, bucket, token, fetchImpl = fetch }) {
  assert.ok(token, "CLOUDFLARE_API_TOKEN ausente");
  assert.match(bucket, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, "Bucket frio inválido");
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/lock`;
  const call = async (method, body) => {
    const response = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    // Only the status leaves: provider errors may echo request details.
    assert.ok(response.ok, `Cloudflare R2 lock ${method}: HTTP ${response.status}`);
    return response.json();
  };
  return {
    async rules() {
      const body = await call("GET");
      return body?.result?.rules ?? [];
    },
    /** Adds or extends `wanted`, then reads back and checks every one is in force. */
    async ensure(wanted) {
      const merged = mergeRules(await this.rules(), wanted);
      if (merged) await call("PUT", { rules: merged });
      const after = new Map((await this.rules()).map((rule) => [rule.id, rule]));
      // In force means the same prefix, locked at least until the date asked for.
      for (const rule of wanted) {
        const kept = after.get(rule.id);
        assert.ok(
          kept && kept.prefix === rule.prefix && lockedUntil(kept) >= lockedUntil(rule),
          "Regra de lock ausente depois da gravação",
        );
      }
      return { changed: !!merged, rules: after.size };
    },
  };
}
