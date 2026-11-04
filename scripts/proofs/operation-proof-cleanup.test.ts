import { createServer } from "node:http";
import { expect, it } from "vite-plus/test";
import { cleanupOperationProof } from "../lib/operation-proof-cleanup.mjs";

it("fecha servidor real quando backend de limpeza falha e preserva erro original", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const original = new Error("original proof failure");
  const result = await cleanupOperationProof(
    async () => {
      throw new Error("backend unavailable");
    },
    () => new Promise<void>((resolve) => server.close(() => resolve())),
    original,
  );
  expect(result).toBe(original);
  expect(server.listening).toBe(false);
});
it("registra falha da revogação quando a prova havia passado", async () => {
  const cleanupError = new Error("backend unavailable");
  const result = await cleanupOperationProof(
    async () => {
      throw cleanupError;
    },
    async () => {},
    null,
  );
  expect(result).toBe(cleanupError);
});
