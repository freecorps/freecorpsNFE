import { setImmediate as yieldMacrotask } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { platformTest } from "../../tests/helpers/platform";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * convex-test runs one query or mutation at a time, and a file an action stores is written in a
 * transaction of its own. The published package decided that by asking whether any function held
 * the lock: an action storing while another function ran wrote into that function's transaction,
 * and failed with "Write outside of transaction" once that one committed before the file was
 * hashed. Two concurrent deliveries in the tests of the former e-mail inbox met it in the CI. The patch
 * in `patches/convex-test@0.0.60.patch` asks the caller's own context instead (patches/README.md).
 */
it("an action stores a file in a transaction of its own while another function holds the lock", async () => {
  const t = platformTest();
  let locked!: () => void;
  const holding = new Promise<void>((resolve) => (locked = resolve));
  // A mutation that holds the lock until the microtask queue drains: the action below reaches
  // its store on the microtask queue alone, so the order needs a macrotask turn, not real time
  // (freecorps/no-wall-clock-in-tests).
  const holder = t.run(async () => {
    locked();
    await yieldMacrotask();
  });
  await holding;
  const type = "application/x-synthetic-test";
  // The store hashes the file before inserting its row: the holder commits in between. The bytes
  // come from the blob's stream, which the spy leaves as it is.
  vi.spyOn(Blob.prototype, "arrayBuffer").mockImplementation(async function (this: Blob) {
    if (this.type === type) await holder;
    return new Response(this).arrayBuffer();
  });
  const id = await t.action(async (ctx) => ctx.storage.store(new Blob(["sintético"], { type })));
  await holder;
  expect(await t.run((ctx) => ctx.db.system.get(id))).toMatchObject({
    size: new TextEncoder().encode("sintético").byteLength,
  });
  expect(await t.run(async (ctx) => (await ctx.storage.get(id))?.text())).toBe("sintético");
});
