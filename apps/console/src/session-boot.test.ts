import { beforeEach, expect, it, vi } from "vite-plus/test";

const auth = vi.hoisted(() => ({
  token: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("./session-hint", () => ({ browserSessionHint: () => true }));
vi.mock("./auth", () => ({
  authClient: {
    convex: { token: auth.token },
    $store: { atoms: { session: { subscribe: auth.subscribe } } },
  },
}));

beforeEach(() => {
  vi.resetModules();
  auth.token.mockReset();
  auth.subscribe.mockReset();
});

it("keeps the early token when the session store cannot be read", async () => {
  auth.token.mockResolvedValue({ data: { token: "convex-token" } });
  auth.subscribe.mockImplementation(() => {
    throw new Error("store indisponível");
  });
  const { settledEarlyToken } = await import("./session-boot");
  await expect(settledEarlyToken(1_000)).resolves.toBe("convex-token");
});

it("boots without a token when the token request fails", async () => {
  auth.token.mockRejectedValue(new Error("rede"));
  auth.subscribe.mockImplementation((listener: (value: { isPending: boolean }) => void) => {
    listener({ isPending: false });
    return () => {};
  });
  const { settledEarlyToken } = await import("./session-boot");
  await expect(settledEarlyToken(1_000)).resolves.toBeNull();
});

it("gives up on the head start after the wait", async () => {
  auth.token.mockReturnValue(new Promise(() => {}));
  auth.subscribe.mockReturnValue(() => {});
  const { settledEarlyToken } = await import("./session-boot");
  await expect(settledEarlyToken(10)).resolves.toBeNull();
});
