import { it, vi } from "vite-plus/test";

const leftover = globalThis as typeof globalThis & { ranFirst?: boolean; fired?: boolean };

// Deixa para trás o que um arquivo esquecido deixaria.
it("leaves state behind", () => {
  setTimeout(() => (leftover.fired = true), 200);
  vi.useFakeTimers();
  process.env.FILE_ISOLATION_LEAK = "a";
  vi.stubEnv("FILE_ISOLATION_STUB", "a");
  vi.stubGlobal("fileIsolationGlobal", "a");
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  leftover.ranFirst = true;
});
