import { beforeEach, afterEach, vi } from "vite-plus/test";
import http from "node:http";
import https from "node:https";

// No fall-through to real HTTP. Tests may replace these with explicit mocks.
let attempted = false;
function blocked(): never {
  attempted = true;
  throw new Error("Unmocked HTTP is forbidden in the isolated test suite");
}
beforeEach(() => {
  attempted = false;
  vi.stubGlobal("fetch", blocked);
  vi.spyOn(http, "request").mockImplementation(blocked);
  vi.spyOn(http, "get").mockImplementation(blocked);
  vi.spyOn(https, "request").mockImplementation(blocked);
  vi.spyOn(https, "get").mockImplementation(blocked);
});
afterEach(() => {
  if (attempted)
    throw new Error("A test attempted unmocked HTTP, even if its code caught the error");
});
