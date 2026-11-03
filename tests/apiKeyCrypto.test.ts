import { describe, expect, it } from "vite-plus/test";
import {
  API_KEY_PREFIX,
  generateApiKeySecret,
  hashApiKey,
  looksLikeApiKey,
} from "../platform/convex/lib/apiKeyCrypto";

describe("apiKeyCrypto", () => {
  it("gera segredos únicos com o prefixo fnfe_", () => {
    const a = generateApiKeySecret();
    const b = generateApiKeySecret();
    expect(a).not.toBe(b);
    expect(a.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(looksLikeApiKey(a)).toBe(true);
    expect(looksLikeApiKey("Bearer xyz")).toBe(false);
  });

  it("hash SHA-256 é determinístico e hex de 64 chars", async () => {
    const secret = generateApiKeySecret();
    const h1 = await hashApiKey(secret);
    const h2 = await hashApiKey(secret);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashApiKey(secret + "x")).not.toBe(h1);
  });
});
